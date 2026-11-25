-- Bug achado em auditoria (2026-11-04), corrigido em 2026-11-06: p_motivo
-- era recebido do cliente (orcamento-publico.html coleta o motivo da
-- recusa) mas o UPDATE fazia "observacoes = observacoes" -- no-op, o motivo
-- sempre se perdia. pedidos.html espera exibir o.observacoes no detalhe do
-- orcamento recusado.
create or replace function comercial.recusar_orcamento_publico(p_token uuid, p_motivo text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare o comercial.orcamentos%rowtype;
begin
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;
  if o.status = 'cancelado' then return jsonb_build_object('ok', true, 'ja_cancelado', true); end if;
  if o.status not in ('enviado','visualizado') then return jsonb_build_object('ok', false, 'motivo', 'indisponivel'); end if;
  update comercial.orcamentos set status = 'cancelado', cancelado_por = 'cliente', cancelado_em = now(),
    observacoes = trim(both E'\n' from coalesce(observacoes || E'\n\n', '') ||
      'Motivo da recusa (cliente): ' || coalesce(nullif(trim(p_motivo), ''), 'nao informado')),
    atualizado_em = now() where id = o.id;
  return jsonb_build_object('ok', true, 'codigo', o.codigo);
end $function$;
