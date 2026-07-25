# db/

Acesso a dados. Um único `PrismaClient` compartilhado e repositórios finos
(tenant, patient, slot, appointment, conversation).

**Regra de ouro (multi-tenant):** toda query filtra por `tenantId`. Nenhum dado
de uma clínica pode vazar para outra.

Implementado na Fase 1/2.
