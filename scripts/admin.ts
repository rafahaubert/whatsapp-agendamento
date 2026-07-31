/**
 * Gestão dos usuários do painel pela linha de comando — a saída de emergência
 * quando ninguém consegue mais entrar (senha perdida, usuário desativado…).
 * Aponta para o mesmo banco do ambiente (DATABASE_URL), então roda tanto local
 * quanto no shell do servidor.
 *
 * Uso:
 *   npm run admin -- listar
 *   npm run admin -- criar <e-mail> <senha> [nome]   (cria um SUPER)
 *   npm run admin -- senha <e-mail> <senha>          (redefine a senha)
 *   npm run admin -- ativar <e-mail>
 *   npm run admin -- hash <senha>                    (gera ADMIN_PASSWORD_HASH)
 */
import { prisma } from "../src/db/client.js";
import { hashSenha } from "../src/admin/auth.js";

const [comando, ...args] = process.argv.slice(2);

function uso(msg?: string): never {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Uso:
  npm run admin -- listar
  npm run admin -- criar <e-mail> <senha> [nome]
  npm run admin -- senha <e-mail> <senha>
  npm run admin -- ativar <e-mail>
  npm run admin -- hash <senha>
`);
  process.exit(1);
}

function validarSenha(senha: string): string {
  if (!senha || senha.length < 8) uso("A senha precisa ter ao menos 8 caracteres.");
  return senha;
}

function normalizarEmail(email: string): string {
  if (!email) uso("Informe o e-mail.");
  return email.trim().toLowerCase();
}

async function main() {
  switch (comando) {
    case "listar": {
      const usuarios = await prisma.adminUser.findMany({
        orderBy: [{ role: "asc" }, { email: "asc" }],
        include: { tenant: { select: { name: true } } },
      });
      if (usuarios.length === 0) {
        console.log(
          "Nenhum usuário cadastrado — o painel aceita ADMIN_USER/ADMIN_PASSWORD do ambiente.",
        );
        break;
      }
      console.log(`${usuarios.length} usuário(s) — o login é o E-MAIL:\n`);
      for (const u of usuarios) {
        const clinica = u.tenant ? ` · ${u.tenant.name}` : "";
        console.log(
          `  ${u.email}  [${u.role}${clinica}]  ${u.isActive ? "ativo" : "DESATIVADO"}` +
            `  último acesso: ${u.lastLoginAt?.toISOString() ?? "nunca"}`,
        );
      }
      break;
    }

    case "criar": {
      const email = normalizarEmail(args[0]);
      const senha = validarSenha(args[1]);
      const nome = args.slice(2).join(" ") || email;
      const jaExiste = await prisma.adminUser.findUnique({ where: { email } });
      if (jaExiste) {
        uso(`Já existe um usuário com o e-mail "${email}". Para trocar a senha dele:\n` +
          `  npm run admin -- senha ${email} <senha>`);
      }
      await prisma.adminUser.create({
        data: { email, name: nome, passwordHash: await hashSenha(senha), role: "SUPER" },
      });
      console.log(`✅ SUPER criado: ${email}`);
      break;
    }

    case "senha": {
      const email = normalizarEmail(args[0]);
      const senha = validarSenha(args[1]);
      const { count } = await prisma.adminUser.updateMany({
        where: { email },
        data: { passwordHash: await hashSenha(senha) },
      });
      if (count === 0) uso(`Nenhum usuário com o e-mail "${email}". Veja: npm run admin -- listar`);
      console.log(`✅ Senha redefinida: ${email}`);
      break;
    }

    case "ativar": {
      const email = normalizarEmail(args[0]);
      const { count } = await prisma.adminUser.updateMany({
        where: { email },
        data: { isActive: true },
      });
      if (count === 0) uso(`Nenhum usuário com o e-mail "${email}". Veja: npm run admin -- listar`);
      console.log(`✅ Acesso reativado: ${email}`);
      break;
    }

    /**
     * Gera o valor de ADMIN_PASSWORD_HASH. Não toca no banco — é só o scrypt,
     * o mesmo usado nas senhas dos usuários do painel.
     */
    case "hash": {
      const senha = validarSenha(args[0]);
      const hash = await hashSenha(senha);
      console.log(`\nADMIN_PASSWORD_HASH=${hash}\n`);
      console.log("Defina esta variável no provedor e REMOVA a ADMIN_PASSWORD.");
      console.log("  Fly:    fly secrets set 'ADMIN_PASSWORD_HASH=...' && fly secrets unset ADMIN_PASSWORD");
      console.log("  Render: painel → Environment (marque como secret)\n");
      break;
    }

    default:
      uso(comando ? `Comando desconhecido: ${comando}` : undefined);
  }
}

main()
  .catch((err) => {
    console.error("❌ Falhou:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
