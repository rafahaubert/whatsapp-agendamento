-- Duração e preço por procedimento.
--
-- Havia UM `slotDurationMinutes` global por clínica: uma limpeza de 15 minutos e
-- um canal de 90 ocupavam exatamente o mesmo slot. É a objeção número um de
-- qualquer clínica odontológica — ou se perde agenda no procedimento curto, ou
-- se atrasa o dia inteiro no longo.
ALTER TABLE "specialties" ADD COLUMN "durationMinutes" INTEGER;

-- `priceParticular` é texto livre ("A partir de R$ 120") e serve para o paciente
-- ler. Este é o número que o relatório de faturamento consegue somar — sem ele o
-- painel sabia o custo de API em dólar e ignorava a receita da clínica.
ALTER TABLE "specialties" ADD COLUMN "priceCents" INTEGER;
