alter table comercial.hub_notas_fiscais add column if not exists erp_pedido_id varchar(30);
comment on column comercial.hub_notas_fiscais.erp_pedido_id is 'sale.id cru do Zen (venda de origem da NF via invoice), preenchido mesmo quando a venda nao nasceu no Hub (pedido_id fica null nesse caso). Backfill manual via /api/sync-financeiro?backfill_pedido_nf=1.';
