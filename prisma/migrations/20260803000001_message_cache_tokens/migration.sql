-- AlterTable: faixas de preço do prompt caching.
-- Com cache ligado, `inputTokens` passa a contar só o input NÃO cacheado (1x).
-- Escrita de cache custa 1,25x e leitura 0,1x — sem colunas próprias o painel
-- reportaria uma economia que não existe.
ALTER TABLE "messages" ADD COLUMN "cacheCreationTokens" INTEGER;
ALTER TABLE "messages" ADD COLUMN "cacheReadTokens" INTEGER;
