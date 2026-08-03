-- Desfecho da consulta: base da taxa de falta.
--
-- Antes, marcar comparecimento dependia inteiramente de a recepção clicar no
-- painel. Sem o clique o agendamento ficava SCHEDULED para sempre, e a taxa de
-- falta — a métrica que sustenta a renovação do contrato — ficava nula
-- justamente na clínica que menos tem disciplina de clicar.

-- Quando perguntamos ao paciente se ele compareceu (evita perguntar de novo).
ALTER TABLE "appointments" ADD COLUMN "outcomeAskedAt" TIMESTAMP(3);

-- Desfecho presumido por falta de resposta, não confirmado por ninguém.
-- Separado para o painel não vender como fato o que é estimativa.
ALTER TABLE "appointments" ADD COLUMN "outcomeAuto" BOOLEAN NOT NULL DEFAULT false;
