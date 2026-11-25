
drop function if exists public.link_registrar(text, text, uuid, text, text, text, text, jsonb);
create or replace function public.link_registrar(p_origem text, p_token text, p_ref uuid, p_referencia text, p_email text, p_evento text, p_ua text default null, p_detalhe jsonb default null, p_ip text default null)
returns void language plpgsql security definer set search_path to '' as $f$
declare v_fora boolean := false; r record;
begin
  if p_evento not in ('proposta_criada','proposta_cancelada') and p_email is not null and p_token is not null then
    select * into r from public.link_resolver(p_origem, p_token);
    if found then v_fora := not (lower(p_email) = any(r.emails)); end if;
  end if;
  insert into public.link_acessos (origem, token, ref_id, referencia, email, evento, ip, user_agent, detalhe, fora_cadastro)
  values (p_origem, p_token, p_ref, p_referencia, lower(p_email), p_evento, coalesce(nullif(p_ip, ''), public.link_ip()), left(p_ua, 300), p_detalhe, v_fora);
end $f$;
revoke all on function public.link_registrar(text, text, uuid, text, text, text, text, jsonb, text) from public, anon, authenticated;

-- pedido de codigo: grava o IP real do visitante (o Hub repassa)
create or replace function public.link_pedir_codigo(p_origem text, p_token text, p_email text, p_ip text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare r record; v_email text := lower(trim(coalesce(p_email, ''))); v_cod text; v_n int; v_ip text := coalesce(nullif(p_ip, ''), 'desconhecido'); v_fora boolean;
begin
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return jsonb_build_object('status', 'email_invalido'); end if;
  select * into r from public.link_resolver(p_origem, p_token);
  if not found then return jsonb_build_object('status', 'nao_encontrado'); end if;
  if not r.ativo then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_negado_cancelado', null, null, v_ip);
    return jsonb_build_object('status', 'cancelado');
  end if;
  if r.expira_em is not null and r.expira_em < now() then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_negado_expirado', null, null, v_ip);
    return jsonb_build_object('status', 'expirado');
  end if;
  select count(*) into v_n from public.link_codigos where ip = v_ip and criado_em > now() - interval '10 minutes';
  if v_n >= 20 then return jsonb_build_object('status', 'limite'); end if;
  select count(*) into v_n from public.link_codigos where origem = p_origem and token = p_token and lower(email) = v_email and criado_em > now() - interval '15 minutes';
  if v_n >= 5 then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_limite', null, null, v_ip);
    return jsonb_build_object('status', 'limite');
  end if;
  v_fora := not (v_email = any(r.emails));
  v_cod := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into public.link_codigos (origem, token, email, codigo_hash, expira_em, ip)
  values (p_origem, p_token, v_email, encode(extensions.digest(v_cod || ':' || p_token, 'sha256'), 'hex'), now() + interval '10 minutes', v_ip);
  perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_enviado', null, jsonb_build_object('outro_email', v_fora), v_ip);
  return jsonb_build_object('status', 'enviado', 'codigo', v_cod, 'referencia', r.referencia, 'nome', r.nome, 'outro_email', v_fora);
end $f$;
revoke all on function public.link_pedir_codigo(text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_pedir_codigo(text, text, text, text) to service_role;

-- validacao feita pelo servidor do Hub (para poder avisar o vendedor); devolve se o e-mail e de fora do cadastro
create or replace function public.link_validar_codigo_srv(p_origem text, p_token text, p_email text, p_codigo text, p_ua text default null, p_ip text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare r record; c record; v_email text := lower(trim(coalesce(p_email, ''))); v_cod text := regexp_replace(coalesce(p_codigo, ''), '\D', '', 'g'); v_sess text; v_exp timestamptz; v_fora boolean;
begin
  select * into r from public.link_resolver(p_origem, p_token);
  if not found or not r.ativo then return jsonb_build_object('ok', false, 'motivo', 'indisponivel'); end if;
  if r.expira_em is not null and r.expira_em < now() then return jsonb_build_object('ok', false, 'motivo', 'expirado'); end if;
  select * into c from public.link_codigos
    where origem = p_origem and token = p_token and lower(email) = v_email and usado_em is null and expira_em > now()
    order by criado_em desc limit 1;
  if not found then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_invalido', p_ua, jsonb_build_object('motivo', 'sem_codigo_ativo'), p_ip);
    return jsonb_build_object('ok', false, 'motivo', 'invalido');
  end if;
  if c.tentativas >= 5 then return jsonb_build_object('ok', false, 'motivo', 'bloqueado'); end if;
  if c.codigo_hash <> encode(extensions.digest(v_cod || ':' || p_token, 'sha256'), 'hex') then
    update public.link_codigos set tentativas = tentativas + 1 where id = c.id;
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_invalido', p_ua, jsonb_build_object('tentativa', c.tentativas + 1), p_ip);
    return jsonb_build_object('ok', false, 'motivo', 'invalido');
  end if;
  update public.link_codigos set usado_em = now() where id = c.id;
  v_sess := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := least(now() + interval '12 hours', coalesce(r.expira_em, now() + interval '12 hours'));
  insert into public.link_sessoes (origem, token, email, sessao_hash, expira_em)
  values (p_origem, p_token, v_email, encode(extensions.digest(v_sess, 'sha256'), 'hex'), v_exp);
  perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_validado', p_ua, null, p_ip);
  v_fora := not (v_email = any(r.emails));
  return jsonb_build_object('ok', true, 'sessao', v_sess, 'email', v_email, 'expira_em', v_exp, 'fora', v_fora);
end $f$;
revoke all on function public.link_validar_codigo_srv(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_validar_codigo_srv(text, text, text, text, text, text) to service_role;

-- aviso ao vendedor: uma vez por (link, e-mail de fora)
create table if not exists public.link_avisos (
  id bigint generated always as identity primary key,
  origem text not null, token text not null, email text not null,
  criado_em timestamptz not null default now(),
  unique (origem, token, email)
);
alter table public.link_avisos enable row level security;

create or replace function public.link_aviso_preparar(p_origem text, p_token text, p_email text, p_ip text default null, p_ua text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_n int; j jsonb;
begin
  insert into public.link_avisos (origem, token, email) values (p_origem, p_token, v_email) on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return null; end if;
  if p_origem = 'diamante' then
    select jsonb_build_object('para_email', d.emitido_por_email, 'para_nome', d.emitido_por_nome, 'referencia', d.codigo, 'cliente', d.cliente_nome, 'cadastrado', d.destinatario_email, 'rotulo', 'proposta', 'tipo', 'Proposta Diamante', 'url', 'https://app.boxersoldas.com.br/proposta-diamante.html')
      into j from public.diamante_propostas d where d.token::text = p_token;
  elsif p_origem = 'orcamento' then
    select jsonb_build_object('para_email', o.vendedor_email, 'para_nome', o.vendedor_nome, 'referencia', o.codigo, 'cliente', o.cliente_nome, 'cadastrado', o.cliente_email, 'rotulo', 'orçamento', 'tipo', 'Orçamento de Revendas', 'url', 'https://app.boxersoldas.com.br/tabela-teste.html?t=1')
      into j from comercial.orcamentos o where o.token::text = p_token;
  elsif p_origem = 'proposta' then
    select jsonb_build_object('para_email', p.vendedor_email, 'para_nome', p.vendedor_nome, 'referencia', p.codigo, 'cliente', p.cliente_nome,
      'cadastrado', coalesce((select string_agg(distinct lower(c.email), ', ') from comercial.proposta_contatos c where c.proposta_id = p.id and coalesce(c.email, '') <> ''), ''), 'rotulo', 'proposta', 'tipo', 'Proposta BMAX/Laser', 'url', 'https://app.boxersoldas.com.br/propostas/index.html')
      into j from comercial.propostas p where p.link_token = p_token;
  end if;
  if j is null or coalesce(j ->> 'para_email', '') = '' then return null; end if;
  return j || jsonb_build_object('email_acesso', v_email, 'ip', p_ip, 'aparelho', left(p_ua, 200), 'quando', now());
end $f$;
revoke all on function public.link_aviso_preparar(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_aviso_preparar(text, text, text, text, text) to service_role;
