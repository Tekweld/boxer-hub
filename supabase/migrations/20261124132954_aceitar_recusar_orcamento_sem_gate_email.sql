CREATE OR REPLACE FUNCTION comercial.aceitar_orcamento_publico_v2(p_token uuid, p_nome text, p_sessao text, p_ua text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o comercial.orcamentos%rowtype; v_email text;
begin
  if p_sessao is not null and p_sessao <> '' then
    v_email := public.link_sessao_email('orcamento', p_token::text, p_sessao);
    if v_email is null then return jsonb_build_object('ok', false, 'motivo', 'sessao'); end if;
  else
    v_email := 'link_direto';
  end if;
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;
  if o.status in ('aceito_cliente','aprovado') then return jsonb_build_object('ok', true, 'ja_aceito', true, 'codigo', o.codigo); end if;
  if o.status in ('cancelado') then return jsonb_build_object('ok', false, 'motivo', 'cancelado'); end if;
  if o.validade_em < now() then return jsonb_build_object('ok', false, 'motivo', 'expirado'); end if;
  update comercial.orcamentos set status = 'aceito_cliente', aceito_em = now(), aceito_nome = nullif(trim(p_nome), ''), atualizado_em = now() where id = o.id;
  perform public.link_registrar('orcamento', p_token::text, o.id, o.codigo, v_email, 'aceitou', p_ua, jsonb_build_object('nome', nullif(trim(p_nome), '')));
  return jsonb_build_object('ok', true, 'codigo', o.codigo);
end $function$;

CREATE OR REPLACE FUNCTION comercial.recusar_orcamento_publico_v2(p_token uuid, p_motivo text, p_sessao text, p_ua text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o comercial.orcamentos%rowtype; v_email text;
begin
  if p_sessao is not null and p_sessao <> '' then
    v_email := public.link_sessao_email('orcamento', p_token::text, p_sessao);
    if v_email is null then return jsonb_build_object('ok', false, 'motivo', 'sessao'); end if;
  else
    v_email := 'link_direto';
  end if;
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;
  if o.status = 'cancelado' then return jsonb_build_object('ok', true, 'ja_cancelado', true); end if;
  if o.status not in ('enviado','visualizado') then return jsonb_build_object('ok', false, 'motivo', 'indisponivel'); end if;
  update comercial.orcamentos set status = 'cancelado', cancelado_por = 'cliente', cancelado_em = now(),
    observacoes = trim(both E'\n' from coalesce(observacoes || E'\n\n', '') || 'Motivo da recusa (cliente): ' || coalesce(nullif(trim(p_motivo), ''), 'nao informado')),
    atualizado_em = now() where id = o.id;
  perform public.link_registrar('orcamento', p_token::text, o.id, o.codigo, v_email, 'recusou', p_ua);
  return jsonb_build_object('ok', true, 'codigo', o.codigo);
end $function$;
