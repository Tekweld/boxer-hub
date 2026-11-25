-- Pedidos que foram ao Zen antes de o push gravar a etapa inicial ficaram com
-- a timeline comecando no meio. Preenche a partir de erp_sincronizado_em, que
-- e a hora real do envio.
insert into comercial.hub_pedido_eventos (pedido_id, etapa, origem, detalhe, criado_em)
select p.id, 'Enviado ao ERP', 'hub', 'venda ' || p.erp_pedido_id,
       coalesce(p.erp_sincronizado_em, p.atualizado_em, p.criado_em)
  from comercial.hub_pedidos p
 where p.erp_pedido_id is not null
   and not exists (
     select 1 from comercial.hub_pedido_eventos e
      where e.pedido_id = p.id and e.etapa = 'Enviado ao ERP')
on conflict (pedido_id, etapa) do nothing;