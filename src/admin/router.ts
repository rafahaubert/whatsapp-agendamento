import express, { type Request, type Response, type Router } from "express";
import {
  checkCredentials,
  isLoggedIn,
  login,
  logout,
  requireAuth,
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
  remove,
  generateAgenda,
  listAppointments,
  listAppointmentsRange,
  listConversations,
  resetConversation,
} from "./tenantAdmin.js";
import { serviceAccountEmail } from "../integrations/googleCalendar.js";
import type { TenantConfig } from "../config/types.js";

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
    days[i] = bool(body[`day_${i}_aberto`])
      ? { open: body[`day_${i}_open`] || "08:00", close: body[`day_${i}_close`] || "18:00" }
      : null;
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
    knowledgeBase: (body.knowledgeBase ?? "").trim() || undefined,
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
    res.render("admin/login", { erro: req.query.erro ? "Usuário ou senha inválidos." : null });
  });

  router.post("/login", (req: Request, res: Response) => {
    const user = String(req.body.user ?? "");
    const password = String(req.body.password ?? "");
    if (checkCredentials(user, password)) {
      login(req, user);
      return res.redirect("/admin");
    }
    res.redirect("/admin/login?erro=1");
  });

  router.post("/logout", (req: Request, res: Response) => {
    logout(req);
    res.redirect("/admin/login");
  });

  // ----- Daqui em diante, exige autenticação -----
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response) => {
    const clinicas = await listTenants();
    res.render("admin/dashboard", { clinicas, msg: req.query.msg ?? null });
  });

  router.get("/clinicas/nova", (_req: Request, res: Response) => {
    res.render("admin/clinica_nova", { erro: null });
  });

  router.post("/clinicas", async (req: Request, res: Response) => {
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
    const agendamentos = await listAppointments(t.id, t.timezone);
    const conversas = await listConversations(t.id);
    res.render("admin/clinica", {
      t,
      cfg: t.parsedConfig,
      agendamentos,
      conversas,
      googleEmail: serviceAccountEmail(),
      msg: req.query.msg ?? null,
      erro: req.query.erro ?? null,
    });
  });

  router.post("/clinicas/:id/conversa/reiniciar", async (req: Request, res: Response) => {
    await resetConversation(req.params.id, String(req.body.phone ?? ""));
    res.redirect(clinicaUrl(req.params.id, { msg: "Conversa reiniciada" }, "ferramentas"));
  });

  // ----- Calendário -----
  router.get("/clinicas/:id/calendario", async (req: Request, res: Response) => {
    const t = await getTenant(req.params.id);
    if (!t) return res.redirect("/admin");
    res.render("admin/calendario", { t });
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

  router.post("/clinicas/:id/excluir/:entity/:entId", async (req: Request, res: Response) => {
    const entity = req.params.entity as "unit" | "specialty" | "insurer" | "healthPlan" | "doctor";
    const anchor = { unit: "unidades", specialty: "especialidades", insurer: "convenios", healthPlan: "convenios", doctor: "medicos" }[entity];
    const r = await remove(req.params.id, entity, req.params.entId);
    res.redirect(clinicaUrl(req.params.id, r.ok ? undefined : { erro: r.erro }, anchor));
  });

  // ----- Agenda -----
  router.post("/clinicas/:id/agenda/gerar", async (req: Request, res: Response) => {
    const n = await generateAgenda(req.params.id, num(req.body.days, 7));
    res.redirect(clinicaUrl(req.params.id, { msg: `${n} horários gerados` }, "agenda"));
  });

  return router;
}
