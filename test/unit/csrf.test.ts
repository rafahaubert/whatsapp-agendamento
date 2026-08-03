import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { csrfToken, verifyCsrf, exposeCsrf, CAMPO_CSRF, HEADER_CSRF } from "../../src/admin/csrf.js";

/**
 * Requisição falsa com o mínimo que o middleware toca. A sessão é um objeto
 * simples — é assim que o express-session a entrega.
 *
 * `session` e `header` saem do `Partial<Request>` porque os tipos reais do
 * express-session e do express exigem muito mais do que o middleware toca
 * (`id`, `cookie`, `regenerate`, a sobrecarga de `set-cookie`…). Reconstruí-los
 * aqui só para satisfazer o compilador não testaria nada a mais.
 */
type ReqFalsa = Omit<Partial<Request>, "session" | "header"> & {
  session?: Record<string, unknown>;
  header?: (nome: string) => string | undefined;
};

function req(over: ReqFalsa = {}): Request {
  return {
    method: "POST",
    originalUrl: "/admin/usuarios",
    ip: "1.2.3.4",
    session: {},
    body: {},
    header: () => undefined,
    is: () => false,
    ...over,
  } as unknown as Request;
}

function res() {
  const r = {
    statusCode: 200,
    locals: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    corpoJson: undefined as unknown,
    viewRenderizada: undefined as string | undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(o: unknown) {
      this.corpoJson = o;
      return this;
    },
    render(v: string) {
      this.viewRenderizada = v;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return r as unknown as Response & typeof r;
}

describe("token de CSRF", () => {
  it("gera um token e o reusa na mesma sessão", () => {
    const r = req();
    const t1 = csrfToken(r);
    const t2 = csrfToken(r);
    expect(t1).toBe(t2);
    expect(t1).toHaveLength(64); // 32 bytes em hex
  });

  it("gera tokens diferentes para sessões diferentes", () => {
    expect(csrfToken(req())).not.toBe(csrfToken(req()));
  });

  it("publica o token nas locals da view e no header", () => {
    const rq = req({ method: "GET" });
    const rs = res();
    const next = vi.fn();
    exposeCsrf(rq, rs, next);
    expect(next).toHaveBeenCalled();
    expect(rs.locals.csrf).toHaveLength(64);
    expect(rs.headers[HEADER_CSRF]).toBe(rs.locals.csrf);
  });
});

describe("verifyCsrf", () => {
  it("deixa passar métodos que não alteram estado", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const next = vi.fn();
      verifyCsrf(req({ method }), res(), next);
      expect(next, method).toHaveBeenCalled();
    }
  });

  it("aceita o token vindo no corpo do formulário", () => {
    const sessao: Record<string, unknown> = {};
    const rq = req({ session: sessao });
    const token = csrfToken(rq);
    const next = vi.fn();
    verifyCsrf(req({ session: sessao, body: { [CAMPO_CSRF]: token } }), res(), next);
    expect(next).toHaveBeenCalled();
  });

  it("aceita o token vindo no header (usado pelo fetch do calendário)", () => {
    const sessao: Record<string, unknown> = {};
    const token = csrfToken(req({ session: sessao }));
    const next = vi.fn();
    verifyCsrf(
      req({ session: sessao, header: (n: string) => (n === HEADER_CSRF ? token : undefined) }),
      res(),
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it("rejeita quando não vem token", () => {
    const sessao: Record<string, unknown> = {};
    csrfToken(req({ session: sessao }));
    const rs = res();
    const next = vi.fn();
    verifyCsrf(req({ session: sessao }), rs, next);
    expect(next).not.toHaveBeenCalled();
    expect(rs.statusCode).toBe(403);
  });

  it("rejeita um token errado do mesmo tamanho", () => {
    const sessao: Record<string, unknown> = {};
    csrfToken(req({ session: sessao }));
    const rs = res();
    const next = vi.fn();
    verifyCsrf(req({ session: sessao, body: { [CAMPO_CSRF]: "a".repeat(64) } }), rs, next);
    expect(next).not.toHaveBeenCalled();
    expect(rs.statusCode).toBe(403);
  });

  it("rejeita o token de OUTRA sessão — é o ponto todo da proteção", () => {
    const daVitima: Record<string, unknown> = {};
    csrfToken(req({ session: daVitima }));
    const doAtacante = csrfToken(req({ session: {} }));

    const rs = res();
    const next = vi.fn();
    verifyCsrf(req({ session: daVitima, body: { [CAMPO_CSRF]: doAtacante } }), rs, next);
    expect(next).not.toHaveBeenCalled();
    expect(rs.statusCode).toBe(403);
  });

  it("rejeita quando a sessão não tem token (sessão expirada)", () => {
    const rs = res();
    const next = vi.fn();
    verifyCsrf(req({ body: { [CAMPO_CSRF]: "b".repeat(64) } }), rs, next);
    expect(next).not.toHaveBeenCalled();
    expect(rs.statusCode).toBe(403);
  });

  it("responde JSON para requisição JSON e HTML para formulário", () => {
    const sessao: Record<string, unknown> = {};
    csrfToken(req({ session: sessao }));

    const rsJson = res();
    verifyCsrf(req({ session: sessao, is: () => "json" }), rsJson, vi.fn());
    expect(rsJson.corpoJson).toHaveProperty("erro");
    expect(rsJson.viewRenderizada).toBeUndefined();

    const rsHtml = res();
    verifyCsrf(req({ session: sessao }), rsHtml, vi.fn());
    expect(rsHtml.viewRenderizada).toBe("admin/erro");
  });
});
