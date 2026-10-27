-- Libera o credito reservado quando um pedido e reprovado no workflow do Zen.
--
-- hub_fn_submeter_pedido reserva credito na hora (limite_disponivel -= valor_total),
-- mas nada liberava de volta quando o Zen reprova o pedido (workflow chega em
-- 'Pedido reprovado') -- so hub_fn_reverter_pedido devolve, e so funciona
-- enquanto erp_pedido_id IS NULL (pedido nunca chegou a sincronizar). Um pedido
-- que SINCRONIZOU e so depois foi reprovado no Zen ficava com o credito preso
-- para sempre. Achado em 2026-10-27 num teste real com a APM.
--
-- Chamado por api/sync-pedidos-zen.js via RPC quando detecta a transicao para
-- 'Pedido reprovado'. Idempotente: so libera se o pedido ainda nao estiver
-- marcado como rejeitado (o proprio job so chama uma vez, mas o guard evita
-- liberar em dobro se for chamado de novo por engano).
create or replace function comercial.hub_fn_liberar_credito_rejeitado(p_pedido_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_pedido record;
  v_devolver numeric(12,2);
begin
  select * into v_pedido from comercial.hub_pedidos
   where id = p_pedido_id and ativo = true
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  end if;

  if v_pedido.status = 'rejeitado' then
    return jsonb_build_object('ok', true, 'ja_liberado', true);
  end if;

  v_devolver := coalesce(v_pedido.valor_total, 0);

  update comercial.hub_clientes
     set limite_disponivel = least(
           coalesce(limite_disponivel, 0) + v_devolver,
           coalesce(limite_credito, 0)
         ),
         atualizado_em = now()
   where id = v_pedido.cliente_id;

  update comercial.hub_pedidos set
    status        = 'rejeitado',
    atualizado_em = now()
  where id = p_pedido_id;

  insert into comercial.hub_log_alteracoes
    (usuario_id, usuario_email, tabela_ref, registro_id, campo,
     valor_anterior, valor_novo, acao)
  values
    (null, 'sync-pedidos-zen', 'hub_pedidos', p_pedido_id::text,
     'status', v_pedido.status, 'rejeitado', 'liberar_credito_rejeitado');

  return jsonb_build_object('ok', true, 'credito_devolvido', v_devolver);
end
$$;
