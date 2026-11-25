
-- ===== ORCAMENTO (Revendas) com sessao por codigo =====
create or replace function comercial.buscar_orcamento_publico_v2(p_token uuid, p_sessao text, p_ua text default null, p_contar boolean default true)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare o comercial.orcamentos%rowtype; v_exp boolean; v_email text;
begin
  v_email := public.link_sessao_email('orcamento', p_token::text, p_sessao);
  if v_email is null then return jsonb_build_object('encontrado', false, 'sessao', false); end if;
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('encontrado', false); end if;
  v_exp := o.validade_em < now() and o.status in ('enviado','visualizado');
  if o.status <> 'cancelado' and p_contar then
    update comercial.orcamentos set
      visualizacoes = visualizacoes + 1,
      primeira_visualizacao_em = coalesce(primeira_visualizacao_em, now()),
      ultima_visualizacao_em = now(),
      status = case when status = 'enviado' and not v_exp then 'visualizado' else status end,
      atualizado_em = now()
    where id = o.id;
    perform public.link_registrar('orcamento', p_token::text, o.id, o.codigo, v_email, 'visualizou', p_ua);
  end if;
  return jsonb_build_object(
    'encontrado', true, 'visualizador', v_email,
    'codigo', o.codigo, 'criado_em', o.criado_em, 'validade_em', o.validade_em,
    'expirado', v_exp, 'status', o.status,
    'vendedor_nome', o.vendedor_nome, 'vendedor_email', o.vendedor_email, 'vendedor_telefone', o.vendedor_telefone,
    'vendedor_empresa', o.vendedor_empresa,
    'cliente_nome', o.cliente_nome, 'cliente_fantasia', o.cliente_fantasia, 'cliente_cnpj', o.cliente_cnpj,
    'cliente_contato', o.cliente_contato, 'cliente_cidade', o.cliente_cidade, 'cliente_uf', o.cliente_uf,
    'cliente_endereco', o.cliente_endereco,
    'uf', o.uf, 'pagamento_tipo', o.pagamento_tipo, 'parcelas', o.parcelas, 'desconto_vista_pct', o.desconto_vista_pct,
    'frete_tipo', o.frete_tipo, 'frete_valor', o.frete_valor, 'observacoes', o.observacoes,
    'itens', o.itens, 'total_itens', o.total_itens, 'total_final', o.total_final,
    'aceito_em', o.aceito_em);
end $f$;
revoke all on function comercial.buscar_orcamento_publico_v2(uuid, text, text, boolean) from public;
grant execute on function comercial.buscar_orcamento_publico_v2(uuid, text, text, boolean) to anon, authenticated;

create or replace function comercial.aceitar_orcamento_publico_v2(p_token uuid, p_nome text, p_sessao text, p_ua text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare o comercial.orcamentos%rowtype; v_email text;
begin
  v_email := public.link_sessao_email('orcamento', p_token::text, p_sessao);
  if v_email is null then return jsonb_build_object('ok', false, 'motivo', 'sessao'); end if;
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;
  if o.status in ('aceito_cliente','aprovado') then return jsonb_build_object('ok', true, 'ja_aceito', true, 'codigo', o.codigo); end if;
  if o.status in ('cancelado') then return jsonb_build_object('ok', false, 'motivo', 'cancelado'); end if;
  if o.validade_em < now() then return jsonb_build_object('ok', false, 'motivo', 'expirado'); end if;
  update comercial.orcamentos set status = 'aceito_cliente', aceito_em = now(), aceito_nome = nullif(trim(p_nome), ''), atualizado_em = now() where id = o.id;
  perform public.link_registrar('orcamento', p_token::text, o.id, o.codigo, v_email, 'aceitou', p_ua, jsonb_build_object('nome', nullif(trim(p_nome), '')));
  return jsonb_build_object('ok', true, 'codigo', o.codigo);
end $f$;
revoke all on function comercial.aceitar_orcamento_publico_v2(uuid, text, text, text) from public;
grant execute on function comercial.aceitar_orcamento_publico_v2(uuid, text, text, text) to anon, authenticated;

create or replace function comercial.recusar_orcamento_publico_v2(p_token uuid, p_motivo text, p_sessao text, p_ua text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare o comercial.orcamentos%rowtype; v_email text;
begin
  v_email := public.link_sessao_email('orcamento', p_token::text, p_sessao);
  if v_email is null then return jsonb_build_object('ok', false, 'motivo', 'sessao'); end if;
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;
  if o.status = 'cancelado' then return jsonb_build_object('ok', true, 'ja_cancelado', true); end if;
  if o.status not in ('enviado','visualizado') then return jsonb_build_object('ok', false, 'motivo', 'indisponivel'); end if;
  update comercial.orcamentos set status = 'cancelado', cancelado_por = 'cliente', cancelado_em = now(),
    observacoes = trim(both E'\n' from coalesce(observacoes || E'\n\n', '') || 'Motivo da recusa (cliente): ' || coalesce(nullif(trim(p_motivo), ''), 'nao informado')),
    atualizado_em = now() where id = o.id;
  perform public.link_registrar('orcamento', p_token::text, o.id, o.codigo, v_email, 'recusou', p_ua);
  return jsonb_build_object('ok', true, 'codigo', o.codigo);
end $f$;
revoke all on function comercial.recusar_orcamento_publico_v2(uuid, text, text, text) from public;
grant execute on function comercial.recusar_orcamento_publico_v2(uuid, text, text, text) to anon, authenticated;

-- ===== PROPOSTA (BMAX/Laser/Robo/Maquinas) com sessao por codigo =====
create or replace function comercial.buscar_proposta_publica_v2(p_token text, p_sessao text, p_ua text default null)
returns table (id uuid, codigo text, cliente_nome text, cliente_cidade text, cliente_estado text, tipo_produto text, prazo_pagamento text, versao integer,
  html_snapshot text, criado_em timestamptz, expirado boolean, link_expira_em timestamptz, vendedor_nome text, vendedor_telefone text, vendedor_email text, visualizador text)
language plpgsql security definer set search_path to '' as $f$
declare v_email text; v_id uuid; v_cod text;
begin
  v_email := public.link_sessao_email('proposta', p_token, p_sessao);
  if v_email is null then return; end if;
  select p.id, p.codigo into v_id, v_cod from comercial.propostas p where p.link_token = p_token and p.ativo;
  if v_id is null then return; end if;
  update comercial.propostas set total_visualizacoes = total_visualizacoes + 1, primeira_visualizacao_em = coalesce(primeira_visualizacao_em, now()),
      ultima_visualizacao_em = now(), visualizacao_nao_lida = true where comercial.propostas.id = v_id;
  insert into comercial.proposta_acessos (proposta_id, user_agent) values (v_id, left(p_ua, 300));
  perform public.link_registrar('proposta', p_token, v_id, v_cod, v_email, 'visualizou', p_ua);
  return query
    select p.id, p.codigo, p.cliente_nome, p.cliente_cidade, p.cliente_estado, p.tipo_produto, p.prazo_pagamento, v.versao, v.html_snapshot, p.criado_em,
      (p.link_expira_em is not null and p.link_expira_em < now()), p.link_expira_em, p.vendedor_nome, p.vendedor_telefone, p.vendedor_email, v_email
    from comercial.propostas p join comercial.proposta_versoes v on v.proposta_id = p.id
    where p.id = v_id order by v.versao desc limit 1;
end $f$;
revoke all on function comercial.buscar_proposta_publica_v2(text, text, text) from public;
grant execute on function comercial.buscar_proposta_publica_v2(text, text, text) to anon, authenticated;

-- novos links de proposta valem 15 dias (antes 30)
alter table comercial.propostas alter column link_expira_em set default (now() + interval '15 days');
