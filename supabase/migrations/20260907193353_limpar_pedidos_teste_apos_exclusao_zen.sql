-- As tres vendas de teste no Zen (48243, 48244, 48814) foram excluidas em
-- 2026-09-07. Sem essa limpeza, o Hub continua com pedidos apontando para ids
-- que nao existem mais, o sync tenta ler a etapa e a timeline segue mostrando
-- a antiga.
-- Solta o vinculo e reverte o pedido para rascunho, com uma nota. Nao apaga o
-- pedido -- Andre pode reaproveitar, e da mais lastro para eventual auditoria.
update comercial.hub_pedidos
   set erp_pedido_id = null,
       erp_workflow_status = null,
       erp_workflow_em = null,
       erp_sincronizado_em = null,
       status = 'rascunho',
       observacoes = coalesce(observacoes || E'\n', '') ||
                     '[' || to_char(now(),'YYYY-MM-DD') || '] venda de teste excluida do Zen, pedido revertido a rascunho'
 where numero in ('HUB-2026-00001','HUB-2026-00002','HUB-2026-00003');

-- E limpa a timeline desses pedidos: eventos apontam para etapa que nao existe
-- mais no Zen. Reenviar gera novos eventos.
delete from comercial.hub_pedido_eventos
 where pedido_id in (
   select id from comercial.hub_pedidos
    where numero in ('HUB-2026-00001','HUB-2026-00002','HUB-2026-00003'));