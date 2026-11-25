CREATE UNIQUE INDEX IF NOT EXISTS hub_pedidos_erp_pedido_id_key
  ON comercial.hub_pedidos (erp_pedido_id)
  WHERE erp_pedido_id IS NOT NULL;
