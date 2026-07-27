import express, { type Request, type Response, type Router } from "express";
import {
  autenticar,
  isLoggedIn,
  login,
  logout,
  requireAuth,
  requireSuper,
  requireTenant,
  usuarioAtual,
  ehSuper,
  hashSenha,
  Role,
  loginBloqueado,
  registrarFalha,
  limparTentativas,
} from "./auth.js";
import {
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  addUnit,
  addSpecialty,
  updateSpecialtyPrice,
  addInsurer,
  addPlan,
  addDoctor,
  updateDoctorCalendarId,
  updateDoctorHours,
  remove,
  generateAgenda,
  listAppointments,
  listAppointmentsRange,
  listConversations,
  resetConversation,
  listInbox,
  listThread,
  countPendentes,
  listPendingAttendance,
  listPatients,
  getPatient,
  type OrdemPacientes,
  listBlocks,
  addBlock,
  removeBlock,
  listUsers,
  createUser,
  setUserActive,
  setUserPassword,
  deleteUser,
} from "./tenantAdmin.js";
import { setHandoff, logMessage } from "../db/conversationRepository.js";
import { sendWhatsAppText } from "../channels/whatsapp/client.js";
import { logger } from "../shared/logger.js";
import { serviceAccountEmail } from "../integrations/googleCalendar.js";
import { findTenantById } from "../db/tenantRepository.js";
import {
  createManualAppointment,
  moveAppointment,
  cancelAppointment,
  marcarComparecimento,
} from "../domain/scheduling.js";
import { calcularMetricas } from "./metrics.js";
import type { TenantConfig, DiaAtendimento } from "../config/types.js";

// ---------- helpers ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bool(v: any): boolean {
  return v === "on" || v === "true" || v === true;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toArr(v: any): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseConfig(body: any, timezone: string): TenantConfig {
  const days: TenantConfig["businessHours"]["days"] = {};
  for (let i = 0; i < 7; i++) {
    if (!bool(body[`day_${i}_aberto`])) {
      days[i] = null;
      continue;
    }
    const inicioIntervalo = (body[`day_${i}_break_start`] ?? "").trim();
    const fimIntervalo = (body[`day_${i}_break_end`] ?? "").trim();
    days[i] = {
      open: body[`day_${i}_open`] || "08:00",
      close: body[`day_${i}_close`] || "18:00",
      // Intervalo (almoço) é opcional: só entra se as duas pontas vierem preenchidas.
      ...(inicioIntervalo && fimIntervalo
        ? { breakStart: inicioIntervalo, breakEnd: fimIntervalo }
        : {}),
    };
  }
  return {
    branding: {
      clinicName: body.branding_clinicName ?? "",
      greetingMessage: body.branding_greeting ?? "",
      fallbackMessage: body.branding_fallback ?? "",
      closingMessage: body.branding_closing ?? "",
    },
    businessHours: { timezone, days },
    booking: {
      slotDurationMinutes: num(body.booking_slotDurationMinutes, 30),
      maxOptionsOffered: num(body.booking_maxOptionsOffered, 3),
      advanceBookingDays: num(body.booking_advanceBookingDays, 30),
      allowCancellation: bool(body.booking_allowCancellation),
      allowReschedule: bool(body.booking_allowReschedule),
      askInsurance: bool(body.booking_askInsurance),
      acceptParticular: bool(body.booking_acceptParticular),
    },
    ai: { model: body.ai_model ?? "claude-haiku-4-5", persona: body.ai_persona ?? "" },
    debounceSeconds: num(body.debounceSeconds, 8),
    knowledgeBase: (body.knowledgeBase ?? "").trim() || undefined,
    reminders: {
      enabled: bool(body.reminders_enabled),
      hoursBefore: num(body.reminders_hoursBefore, 24),
      templateName: (body.reminders_templateName ?? "").trim(),
      templateLang: (body.reminders_templateLang ?? "pt_BR").trim() || "pt_BR",
    },
    waitlist: {
      enabled: bool(body.waitlist_enabled),
      templateName: (body.waitlist_templateName ?? "").trim(),
      templateLang: (body.waitlist_templateLang ?? "pt_BR").trim() || "pt_BR",
    },
    recall: {
      enabled: bool(body.recall_enabled),
      months: num(body.recall_months, 6),
      templateName: (body.recall_templateName ?? "").trim(),
      templateLang: (body.recall_templateLang ?? "pt_BR").trim() || "pt_BR",
    },
  };
}

function clinicaUrl(id: string, params?: Record<string, string>, anchor?: string): string {
  const qs =
    params && Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const frag = anchor ? `#${anchor}` : "";
  return `/admin/clinicas/${id}${qs}${frag}`;
}

export function makeAdminRouter(): Router {
  const router = express.Router();

  // ----- Login (rotas públicas) -----
  router.get("/login", (req: Request, res: Response) => {
    if (isLoggedIn(req)) return res.redirect("/admin");
    const erro =
      req.query.erro === "bloqueado"
        ? "Muitas tentativas. Aguarde alguns minutos e tente novamente."
        : req.query.erro
          ? "Usuário ou senha inválidos."
          : null;
    res.render("admin/login", { erro });
  });

  router.post("/login", async (req: Request, res: Response) => {
    const user = String(req.body.user ?? "");
    const password = String(req.body.password ?? "");
    const chave = `${user.toLowerCase()}|${req.ip}`;

    if (loginBloqueado(chave)) {
      logger.warn({ user, ip: req.ip }, "login bloqueado por excesso de tentativas");
      return res.redirect("/admin/login?erro=bloqueado");
    }

    const autenticado = await autenticar(user, password);
    if (!autenticado) registrarFalha(chave);
    if (autenticado) {
      limparTentativas(chave);
      login(req, autenticado);
      // Usuário de clínica vai direto para a sua clínica.
      return res.redirect(
        autenticado.role === Role.CLINIC && autenticado.tenantId
          ? `/admin/clinicas/${autenticado.tenantId}`
          : "/admin",
      );
    }
    res.redirect("/admin/login?erro=1");
  });

  router.post("/logout", (req: Request, res: Response) => {
    logout(req);
    res.redirect("/admin/login");
  });

  // ----- Daqui em diante, exige autenticação -----
  router.use(requireAuth);

  // Disponibiliza o usuário logado para todas as views (menu, permissões) e o
  // caminho atual (usado para marcar o item ativo no menu lateral).
  router.use(async (req: Request, res: Response, next) => {
    const u = usuarioAtual(req);
    res.locals.usuario = u;
    res.locals.ehSuper = ehSuper(req);
    res.locals.caminhoAtual = req.baseUrl + req.path;

    // O badge de pendentes vive no menu, então precisa existir em TODAS as telas
    // da clínica — não só na que já contava (GET /clinicas/:id). Aqui o :id ainda
    // não foi extraído pela rota, daí a leitura direta do caminho.
    const naRota = /^\/clinicas\/([^/]+)/.exec(req.path);
    const clinicaId = naRota ? naRota[1] : u.tenantId;
    if (req.method === "GET" && clinicaId && clinicaId !== "nova") {
      try {
        res.locals.pendentesNav = await countPendentes(clinicaId);
      } catch {
        // O badge é acessório: se a contagem falhar, a página continua de pé.
      }
    }
    next();
  });

  // Isolamento entre clínicas: vale para TODAS as rotas /clinicas/:id/*
  router.use("/clinicas/:id", requireTenant);

  router.get("/", async (req: Request, res: Response) => {
    // Usuário de clínica não vê a lista — vai direto para a sua.
    const u = usuarioAtual(req);
    if (u.role === Role.CLINIC && u.tenantId) {
      return res.redirect(`/admin/clinicas/${u.tenantId}`);
    }
    const clinicas = await listTenants();
    res.render("admin/dashboard", { clinicas, msg: req.query.msg ?? null });
  });

  router.get("/clinicas/nova", requireSuper, (_req: Request, res: Response) => {
    res.render("admin/clinica_nova", { erro: null });
  });

  router.post("/clinicas", requireSuper, async (req: Request, res: Response) => {
    try {
      const t = await createTenant({
        slug: slugify(req.body.slug || req.body.name),
        name: req.body.name,
        whatsappPhoneNumberId: req.body.whatsappPhoneNumberId,
        timezone: req.body.timezone || "America/Sao_Paulo",
      });
      res.redirect(clinicaUrl(t.id, { msg: "Clínica criada" }));
    } catch {
      res.render("admin/clinica_nova", {
        erro: "Não foi possível criar (slug ou número de WhatsApp já em uso?).",
      });
    }
  });

  router.get("/clinicas/:id", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");
    // Em paralelo: cada round-trip ao banco custa latência (app e banco em regiões diferentes).
    const [agendamentos, conversas, pendentes, bloqueios, semDesfecho] = await Promise.all([
      listAppointments(t.id, t.timezone),
      listConversations(t.id),
      countPendentes(t.id),
      listBlocks(t.id, t.timezone),
      listPendingAttendance(t.id, t.timezone),
    ]);
    res.render("admin/clinica", {
      t,
      cfg: t.parsedConfig,
      agendamentos,
      conversas,
      pendentes,
      bloqueios,
      semDesfecho,
      googleEmail: serviceAccountEmail(),
      msg: req.query.msg ?? null,
      erro: req.query.erro ?? null,
    });
  });

  router.post("/clinicas/:id/conversa/reiniciar", async (req: Request, res: Response) => {
    await resetConversation(req.params.id, String(req.body.phone ?? ""));
    res.redirect(clinicaUrl(req.params.id, { msg: "Conversa reiniciada" }, "ferramentas"));
  });

  // ----- Usuários do painel (somente SUPER) -----
  router.get("/usuarios", requireSuper, async (req: Request, res: Response) => {
    const [usuarios, clinicas] = await Promise.all([listUsers(), listTenants()]);
    res.render("admin/usuarios", {
      usuarios,
      clinicas,
      msg: req.query.msg ?? null,
      erro: req.query.erro ?? null,
    });
  });

  router.post("/usuarios", requireSuper, async (req: Request, res: Response) => {
    const senha = String(req.body.senha ?? "");
    if (senha.length < 8) {
      return res.redirect("/admin/usuarios?erro=" + encodeURIComponent("A senha precisa ter ao menos 8 caracteres."));
    }
    try {
      await createUser({
        email: String(req.body.email ?? ""),
        name: String(req.body.nome ?? ""),
        passwordHash: await hashSenha(senha),
        role: req.body.role === Role.SUPER ? Role.SUPER : Role.CLINIC,
        tenantId: req.body.tenantId ? String(req.body.tenantId) : null,
      });
      res.redirect("/admin/usuarios?msg=" + encodeURIComponent("Usuário criado"));
    } catch {
      res.redirect("/admin/usuarios?erro=" + encodeURIComponent("E-mail já cadastrado."));
    }
  });

  router.post("/usuarios/:userId/senha", requireSuper, async (req: Request, res: Response) => {
    const senha = String(req.body.senha ?? "");
    if (senha.length < 8) {
      return res.redirect("/admin/usuarios?erro=" + encodeURIComponent("A senha precisa ter ao menos 8 caracteres."));
    }
    await setUserPassword(req.params.userId, await hashSenha(senha));
    res.redirect("/admin/usuarios?msg=" + encodeURIComponent("Senha redefinida"));
  });

  router.post("/usuarios/:userId/ativo", requireSuper, async (req: Request, res: Response) => {
    await setUserActive(req.params.userId, bool(req.body.ativar));
    res.redirect("/admin/usuarios?msg=" + encodeURIComponent("Acesso atualizado"));
  });

  router.post("/usuarios/:userId/excluir", requireSuper, async (req: Request, res: Response) => {
    await deleteUser(req.params.userId);
    res.redirect("/admin/usuarios?msg=" + encodeURIComponent("Usuário removido"));
  });

  // ----- Caixa de entrada (transbordo humano) -----
  router.get("/clinicas/:id/inbox", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");

    const telefone = req.query.telefone ? String(req.query.telefone) : null;
    const [conversas, thread] = await Promise.all([
      listInbox(t.id, t.timezone),
      telefone ? listThread(t.id, telefone, t.timezone) : Promise.resolve([]),
    ]);
    const atual = telefone ? conversas.find((c) => c.telefone === telefone) ?? null : null;

    res.render("admin/inbox", {
      t,
      conversas,
      thread,
      telefone,
      atual,
      msg: req.query.msg ?? null,
      erro: req.query.erro ?? null,
    });
  });

  router.post("/clinicas/:id/inbox/responder", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");

    const telefone = String(req.body.telefone ?? "");
    const texto = String(req.body.texto ?? "").trim();
    const voltar = (p: Record<string, string>) =>
      `/admin/clinicas/${req.params.id}/inbox?telefone=${encodeURIComponent(telefone)}&` +
      new URLSearchParams(p).toString();

    if (!telefone || !texto) return res.redirect(voltar({ erro: "Escreva uma mensagem." }));

    try {
      await sendWhatsAppText(t.whatsappPhoneNumberId, telefone, texto);
      await logMessage(t.id, telefone, "OUT", texto, "HUMAN");
      res.redirect(voltar({ msg: "Mensagem enviada" }));
    } catch (err) {
      logger.error({ err, telefone }, "falha ao responder pelo painel");
      res.redirect(
        voltar({
          erro: "Não foi possível enviar. Se passaram mais de 24h da última mensagem do paciente, a Meta bloqueia a resposta livre.",
        }),
      );
    }
  });

  router.post("/clinicas/:id/inbox/handoff", async (req: Request, res: Response) => {
    const telefone = String(req.body.telefone ?? "");
    const ativar = bool(req.body.ativar);
    await setHandoff(req.params.id, telefone, ativar);
    res.redirect(
      `/admin/clinicas/${req.params.id}/inbox?telefone=${encodeURIComponent(telefone)}&msg=` +
        encodeURIComponent(ativar ? "Assumido pela recepção" : "Devolvido ao bot"),
    );
  });

  // ----- Pacientes -----
  const ORDENS: OrdemPacientes[] = ["recentes", "consultas", "faltas", "sumidos"];

  router.get("/clinicas/:id/pacientes", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");

    const pedida = String(req.query.ordem ?? "");
    const ordem: OrdemPacientes = ORDENS.includes(pedida as OrdemPacientes)
      ? (pedida as OrdemPacientes)
      : "recentes";
    const q = String(req.query.q ?? "");
    const pagina = Number.parseInt(String(req.query.pagina ?? "1"), 10) || 1;

    const resultado = await listPatients(t.id, t.timezone, { q, ordem, pagina });
    res.render("admin/pacientes", { t, q, ordem, ...resultado });
  });

  router.get("/clinicas/:id/pacientes/:pacienteId", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");

    const paciente = await getPatient(t.id, req.params.pacienteId, t.timezone);
    if (!paciente) return res.redirect(`/admin/clinicas/${t.id}/pacientes`);

    res.render("admin/paciente", { t, paciente });
  });

  // ----- Calendário -----
  router.get("/clinicas/:id/calendario", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");
    res.render("admin/calendario", { t, cfg: t.parsedConfig, erro: req.query.erro ?? null });
  });

  // ----- Agendamentos (criar / mover / cancelar pelo painel) -----
  router.post("/clinicas/:id/agendamentos", async (req: Request, res: Response) => {
    const tenant = await findTenantById(req.params.id);
    if (!tenant) return res.redirect("/admin");

    const r = (await createManualAppointment(tenant, {
      nome: String(req.body.nome ?? ""),
      cpf: String(req.body.cpf ?? ""),
      telefone: String(req.body.telefone ?? ""),
      doctorId: String(req.body.doctorId ?? ""),
      specialtyId: String(req.body.specialtyId ?? ""),
      unitId: String(req.body.unitId ?? ""),
      startsAt: String(req.body.startsAt ?? ""),
      paymentType: String(req.body.paymentType ?? "PARTICULAR"),
      plano: req.body.plano ? String(req.body.plano) : undefined,
    })) as { erro?: string };

    const voltar = String(req.body.voltar ?? "");
    if (voltar === "calendario") {
      return res.redirect(`/admin/clinicas/${req.params.id}/calendario${r.erro ? "?erro=" + encodeURIComponent(r.erro) : ""}`);
    }
    res.redirect(
      clinicaUrl(req.params.id, r.erro ? { erro: r.erro } : { msg: "Agendamento criado" }, "agenda"),
    );
  });

  router.post("/clinicas/:id/agendamentos/:apptId/cancelar", async (req: Request, res: Response) => {
    const tenant = await findTenantById(req.params.id);
    if (!tenant) return res.redirect("/admin");
    const r = (await cancelAppointment(tenant, req.params.apptId)) as { erro?: string };

    if (String(req.body.voltar ?? "") === "calendario") {
      return res.redirect(`/admin/clinicas/${req.params.id}/calendario`);
    }
    res.redirect(
      clinicaUrl(req.params.id, r.erro ? { erro: r.erro } : { msg: "Agendamento cancelado" }, "agenda"),
    );
  });

  /** Arrastar/soltar no calendário (fetch JSON). */
  router.post("/clinicas/:id/agendamentos/:apptId/mover", async (req: Request, res: Response) => {
    const tenant = await findTenantById(req.params.id);
    if (!tenant) return res.status(404).json({ erro: "Clínica não encontrada." });
    const r = (await moveAppointment(tenant, req.params.apptId, String(req.body.startsAt ?? ""))) as {
      erro?: string;
    };
    if (r.erro) return res.status(400).json(r);
    res.json({ ok: true });
  });

  router.get("/clinicas/:id/eventos.json", async (req: Request, res: Response) => {
    const start = String(req.query.start ?? "");
    const end = String(req.query.end ?? "");
    if (!start || !end) return res.json([]);
    const doctorId = req.query.doctorId ? String(req.query.doctorId) : undefined;
    const eventos = await listAppointmentsRange(req.params.id, start, end, { doctorId });
    res.json(eventos);
  });

  router.post("/clinicas/:id", async (req: Request, res: Response) => {
    const timezone = req.body.timezone || "America/Sao_Paulo";
    const config = parseConfig(req.body, timezone);
    await updateTenant(req.params.id, {
      name: req.body.name,
      whatsappPhoneNumberId: req.body.whatsappPhoneNumberId,
      timezone,
      isActive: bool(req.body.isActive),
      config,
    });
    res.redirect(clinicaUrl(req.params.id, { msg: "Configuração salva" }));
  });

  // ----- Catálogo -----
  router.post("/clinicas/:id/unidades", async (req: Request, res: Response) => {
    await addUnit(req.params.id, { name: req.body.name, address: req.body.address, phone: req.body.phone });
    res.redirect(clinicaUrl(req.params.id, undefined, "unidades"));
  });

  router.post("/clinicas/:id/especialidades", async (req: Request, res: Response) => {
    await addSpecialty(req.params.id, req.body.name, req.body.preco);
    res.redirect(clinicaUrl(req.params.id, undefined, "especialidades"));
  });

  router.post("/clinicas/:id/especialidades/:specId/preco", async (req: Request, res: Response) => {
    await updateSpecialtyPrice(req.params.id, req.params.specId, req.body.preco);
    res.redirect(clinicaUrl(req.params.id, undefined, "especialidades"));
  });

  router.post("/clinicas/:id/convenios", async (req: Request, res: Response) => {
    await addInsurer(req.params.id, { name: req.body.name, code: req.body.code });
    res.redirect(clinicaUrl(req.params.id, undefined, "convenios"));
  });

  router.post("/clinicas/:id/planos", async (req: Request, res: Response) => {
    await addPlan(req.params.id, req.body.insurerId, req.body.name);
    res.redirect(clinicaUrl(req.params.id, undefined, "convenios"));
  });

  router.post("/clinicas/:id/medicos", async (req: Request, res: Response) => {
    await addDoctor(req.params.id, {
      name: req.body.name,
      crm: req.body.crm,
      specialtyIds: toArr(req.body.especialidades),
      unitIds: toArr(req.body.unidades),
      planIds: toArr(req.body.planos),
    });
    res.redirect(clinicaUrl(req.params.id, undefined, "medicos"));
  });

  router.post("/clinicas/:id/medicos/:docId/google", async (req: Request, res: Response) => {
    await updateDoctorCalendarId(req.params.id, req.params.docId, req.body.googleCalendarId);
    res.redirect(clinicaUrl(req.params.id, undefined, "medicos"));
  });

  router.post("/clinicas/:id/medicos/:docId/horarios", async (req: Request, res: Response) => {
    if (bool(req.body.herdar)) {
      await updateDoctorHours(req.params.id, req.params.docId, null);
    } else {
      const days: Record<number, DiaAtendimento | null> = {};
      for (let i = 0; i < 7; i++) {
        if (!bool(req.body[`d${i}_aberto`])) {
          days[i] = null;
          continue;
        }
        const bs = String(req.body[`d${i}_break_start`] ?? "").trim();
        const be = String(req.body[`d${i}_break_end`] ?? "").trim();
        days[i] = {
          open: req.body[`d${i}_open`] || "08:00",
          close: req.body[`d${i}_close`] || "18:00",
          ...(bs && be ? { breakStart: bs, breakEnd: be } : {}),
        };
      }
      await updateDoctorHours(req.params.id, req.params.docId, days);
    }
    res.redirect(
      clinicaUrl(req.params.id, { msg: "Agenda do profissional salva — gere os horários" }, "medicos"),
    );
  });

  router.post("/clinicas/:id/excluir/:entity/:entId", async (req: Request, res: Response) => {
    const entity = req.params.entity as "unit" | "specialty" | "insurer" | "healthPlan" | "doctor";
    const anchor = { unit: "unidades", specialty: "especialidades", insurer: "convenios", healthPlan: "convenios", doctor: "medicos" }[entity];
    const r = await remove(req.params.id, entity, req.params.entId);
    res.redirect(clinicaUrl(req.params.id, r.ok ? undefined : { erro: r.erro }, anchor));
  });

  // ----- Desfecho da consulta (base da taxa de falta) -----
  router.post("/clinicas/:id/agendamentos/:apptId/desfecho", async (req: Request, res: Response) => {
    const tenant = await findTenantById(req.params.id);
    if (!tenant) return res.redirect("/admin");
    const compareceu = String(req.body.compareceu) === "1";
    await marcarComparecimento(tenant, req.params.apptId, compareceu);
    res.redirect(
      clinicaUrl(
        req.params.id,
        { msg: compareceu ? "Marcado como compareceu" : "Marcado como falta" },
        "agenda",
      ),
    );
  });

  // ----- Métricas / ROI -----
  router.get("/clinicas/:id/metricas", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");

    const dias = [7, 30, 90].includes(num(req.query.dias, 30)) ? num(req.query.dias, 30) : 30;
    const metricas = await calcularMetricas(t.id, t.parsedConfig, t.timezone, dias);
    res.render("admin/metricas", { t, metricas, dias });
  });

  // ----- Férias, feriados e ausências -----
  router.post("/clinicas/:id/bloqueios", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");

    const r = await addBlock(
      t.id,
      {
        doctorId: req.body.doctorId ? String(req.body.doctorId) : null,
        startsAt: String(req.body.startsAt ?? ""),
        endsAt: String(req.body.endsAt ?? ""),
        reason: String(req.body.reason ?? ""),
      },
      t.timezone,
    );

    if (!r.ok) {
      return res.redirect(clinicaUrl(req.params.id, { erro: r.erro }, "bloqueios"));
    }
    const msg = r.conflitos.length
      ? `Bloqueio criado. ATENÇÃO: ${r.conflitos.length} consulta(s) já marcada(s) nesse período — ${r.conflitos.slice(0, 3).join("; ")}${r.conflitos.length > 3 ? "…" : ""}`
      : "Bloqueio criado — gere os horários novamente";
    res.redirect(clinicaUrl(req.params.id, { msg }, "bloqueios"));
  });

  router.post("/clinicas/:id/bloqueios/:blockId/excluir", async (req: Request, res: Response) => {
    await removeBlock(req.params.id, req.params.blockId);
    res.redirect(clinicaUrl(req.params.id, { msg: "Bloqueio removido" }, "bloqueios"));
  });

  // ----- Agenda -----
  router.post("/clinicas/:id/agenda/gerar", async (req: Request, res: Response) => {
    const n = await generateAgenda(req.params.id, num(req.body.days, 7));
    res.redirect(clinicaUrl(req.params.id, { msg: `${n} horários gerados` }, "agenda"));
  });

  return router;
}
