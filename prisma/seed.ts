/**
 * Seed CLI — popula o banco a partir de config/clinics/*.json.
 * Uso: npm run seed
 */
import "dotenv/config";
import { prisma } from "../src/db/client.js";
import { loadClinicFiles, seedClinic } from "../src/db/seed.js";

async function main() {
  const files = await loadClinicFiles();
  if (files.length === 0) {
    console.log("Nenhum arquivo em config/clinics/. Nada a fazer.");
    return;
  }

  for (const file of files) {
    const r = await seedClinic(prisma, file);
    console.log(
      `✔ ${r.slug}: ${r.units} unidades, ${r.specialties} especialidades, ${r.plans} planos, ${r.doctors} médicos, ${r.slots} horários`,
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
