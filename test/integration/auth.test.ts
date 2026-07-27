import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { autenticar, hashSenha, Role } from "../../src/admin/auth.js";
import { env } from "../../src/config/env.js";

afterAll(async () => {
  await prisma.$disconnect();
});

// Só roda com um Postgres de teste configurado (ver test/integration/setup.ts).
describe.skipIf(!process.env.TEST_DATABASE_URL)("autenticar (integração)", () => {
  beforeEach(async () => {
    await prisma.adminUser.deleteMany();
  });

  it("aceita a credencial do ambiente com o banco vazio", async () => {
    const r = await autenticar(env.ADMIN_USER, env.ADMIN_PASSWORD);
    expect(r?.role).toBe(Role.SUPER);
  });

  it("recusa a senha errada do ambiente", async () => {
    expect(await autenticar(env.ADMIN_USER, "senha-errada")).toBeNull();
  });

  // REGRESSÃO: criar o primeiro usuário desativava a credencial do ambiente e
  // trancava todo mundo fora do painel (nem o admin entrava mais).
  it("mantém a credencial do ambiente valendo depois de criar um usuário", async () => {
    await prisma.adminUser.create({
      data: {
        email: "rafael@clinica.com",
        name: "Rafael",
        passwordHash: await hashSenha("senha-do-rafael"),
        role: Role.SUPER,
      },
    });

    const r = await autenticar(env.ADMIN_USER, env.ADMIN_PASSWORD);
    expect(r?.role).toBe(Role.SUPER);
  });

  it("autentica o usuário do banco pelo e-mail (sem diferenciar maiúsculas)", async () => {
    await prisma.adminUser.create({
      data: {
        email: "rafael@clinica.com",
        name: "Rafael",
        passwordHash: await hashSenha("senha-do-rafael"),
        role: Role.CLINIC,
      },
    });

    const r = await autenticar("  Rafael@Clinica.com ", "senha-do-rafael");
    expect(r?.nome).toBe("Rafael");
    expect(r?.role).toBe(Role.CLINIC);

    // O login é o e-mail: o nome não serve como identificador.
    expect(await autenticar("Rafael", "senha-do-rafael")).toBeNull();
    expect(await autenticar("rafael@clinica.com", "outra-senha")).toBeNull();
  });

  it("registra o último acesso", async () => {
    const u = await prisma.adminUser.create({
      data: {
        email: "rafael@clinica.com",
        name: "Rafael",
        passwordHash: await hashSenha("senha-do-rafael"),
        role: Role.SUPER,
      },
    });
    expect(u.lastLoginAt).toBeNull();

    await autenticar("rafael@clinica.com", "senha-do-rafael");
    const depois = await prisma.adminUser.findUniqueOrThrow({ where: { id: u.id } });
    expect(depois.lastLoginAt).not.toBeNull();
  });

  it("recusa usuário desativado", async () => {
    await prisma.adminUser.create({
      data: {
        email: "antigo@clinica.com",
        name: "Antigo",
        passwordHash: await hashSenha("senha-do-antigo"),
        role: Role.CLINIC,
        isActive: false,
      },
    });
    expect(await autenticar("antigo@clinica.com", "senha-do-antigo")).toBeNull();
  });

  // Trocar a senha pelo painel precisa valer mesmo quando o e-mail é igual ao
  // ADMIN_USER do ambiente: o registro do banco tem prioridade.
  it("o usuário do banco tem prioridade sobre a credencial do ambiente", async () => {
    await prisma.adminUser.create({
      data: {
        email: env.ADMIN_USER.toLowerCase(),
        name: "Admin do banco",
        passwordHash: await hashSenha("senha-do-banco"),
        role: Role.SUPER,
      },
    });

    expect((await autenticar(env.ADMIN_USER, "senha-do-banco"))?.nome).toBe("Admin do banco");
    expect(await autenticar(env.ADMIN_USER, env.ADMIN_PASSWORD)).toBeNull();
  });
});
