
-- ===== GATE COMUM DE LINK (codigo por e-mail + sessao + auditoria) =====
create table if not exists public.link_codigos (
  id uuid primary key default gen_random_uuid(),
  origem text not null check (origem in ('diamante','orcamento','proposta')),
  token text not null,
  email text not null,
  codigo_hash text not null,
  expira_em timestamptz not null,
  tentativas int not null default 0,
  usado_em timestamptz,
  ip text,
  criado_em timestamptz not null default now()
);
create index if not exists link_codigos_busca on public.link_codigos (origem, token, lower(email), criado_em desc);
create table if not exists public.link_sessoes (
  id uuid primary key default gen_random_uuid(),
  origem text not null,
  token text not null,
  email text not null,
  sessao_hash text not null unique,
  expira_em timestamptz not null,
  criado_em timestamptz not null default now()
);
create table if not exists public.link_acessos (
  id bigint generated always as identity primary key,
  origem text not null,
  token text,
  ref_id uuid,
  referencia text,
  email text,
  evento text not null,
  ip text,
  user_agent text,
  detalhe jsonb,
  criado_em timestamptz not null default now()
);
create index if not exists link_acessos_ref on public.link_acessos (origem, ref_id, criado_em desc);
alter table public.link_codigos enable row level security;
alter table public.link_sessoes enable row level security;
alter table public.link_acessos enable row level security;
create policy link_acessos_admin_ler on public.link_acessos for select to authenticated using (public.eh_perfil_admin());

-- ===== PROPOSTA DIAMANTE (dados congelados) =====
create sequence if not exists public.diamante_proposta_seq;
create table if not exists public.diamante_propostas (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  token uuid not null unique default gen_random_uuid(),
  regiao text not null references public.diamante_regioes(regiao),
  cliente_nome text not null,
  cliente_cnpj text,
  cliente_cidade text,
  cliente_uf text,
  destinatario_nome text,
  destinatario_email text not null,
  destinatario_telefone text,
  itens jsonb not null,
  dados jsonb not null,
  total numeric,
  observacoes text,
  emitido_por uuid not null,
  emitido_por_nome text,
  emitido_por_email text,
  emitido_por_telefone text,
  criado_em timestamptz not null default now(),
  validade_em timestamptz not null,
  status text not null default 'emitida' check (status in ('emitida','visualizada','cancelada')),
  ativo boolean not null default true,
  visualizacoes int not null default 0,
  primeira_visualizacao_em timestamptz,
  ultima_visualizacao_em timestamptz,
  cancelado_em timestamptz,
  cancelado_por text
);
alter table public.diamante_propostas enable row level security;
create policy diamante_propostas_admin on public.diamante_propostas for all to authenticated using (public.eh_perfil_admin()) with check (public.eh_perfil_admin());

-- ===== funcoes internas =====
create or replace function public.link_ip()
returns text language plpgsql stable set search_path to '' as $f$
declare v text;
begin
  begin v := nullif(trim(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1)), ''); exception when others then v := null; end;
  return coalesce(v, 'desconhecido');
end $f$;

create or replace function public.link_resolver(p_origem text, p_token text)
returns table (ref_id uuid, referencia text, nome text, emails text[], expira_em timestamptz, ativo boolean)
language plpgsql stable security definer set search_path to '' as $f$
begin
  if p_origem = 'diamante' then
    return query select d.id, d.codigo, d.cliente_nome, array[lower(d.destinatario_email)], d.validade_em, (d.ativo and d.status <> 'cancelada')
      from public.diamante_propostas d where d.token::text = p_token;
  elsif p_origem = 'orcamento' then
    return query select o.id, o.codigo, o.cliente_nome, array[lower(o.cliente_email)],
        case when o.status in ('aceito_cliente','aprovado') then null else o.validade_em end, (o.ativo and o.status <> 'cancelado')
      from comercial.orcamentos o where o.token::text = p_token;
  elsif p_origem = 'proposta' then
    return query select p.id, p.codigo, p.cliente_nome,
        coalesce((select array_agg(distinct lower(c.email)) from comercial.proposta_contatos c where c.proposta_id = p.id and coalesce(c.email,'') <> ''), array[]::text[]),
        p.link_expira_em, p.ativo
      from comercial.propostas p where p.link_token = p_token;
  end if;
end $f$;
revoke all on function public.link_resolver(text, text) from public, anon, authenticated;

create or replace function public.link_registrar(p_origem text, p_token text, p_ref uuid, p_referencia text, p_email text, p_evento text, p_ua text default null, p_detalhe jsonb default null)
returns void language sql security definer set search_path to '' as $f$
  insert into public.link_acessos (origem, token, ref_id, referencia, email, evento, ip, user_agent, detalhe)
  values (p_origem, p_token, p_ref, p_referencia, lower(p_email), p_evento, public.link_ip(), left(p_ua, 300), p_detalhe);
$f$;
revoke all on function public.link_registrar(text, text, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

create or replace function public.link_sessao_email(p_origem text, p_token text, p_sessao text)
returns text language sql stable security definer set search_path to '' as $f$
  select s.email from public.link_sessoes s
  where s.origem = p_origem and s.token = p_token and s.expira_em > now()
    and s.sessao_hash = encode(extensions.digest(coalesce(p_sessao, ''), 'sha256'), 'hex')
  limit 1;
$f$;
revoke all on function public.link_sessao_email(text, text, text) from public, anon, authenticated;

-- pede o codigo (so o servidor do Hub, com a chave de servico, chama)
create or replace function public.link_pedir_codigo(p_origem text, p_token text, p_email text, p_ip text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare r record; v_email text := lower(trim(coalesce(p_email, ''))); v_cod text; v_n int; v_dica text; v_ip text := coalesce(nullif(p_ip, ''), 'desconhecido');
begin
  select * into r from public.link_resolver(p_origem, p_token);
  if not found then return jsonb_build_object('status', 'nao_encontrado'); end if;
  if not r.ativo then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_negado_cancelado');
    return jsonb_build_object('status', 'cancelado');
  end if;
  if r.expira_em is not null and r.expira_em < now() then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_negado_expirado');
    return jsonb_build_object('status', 'expirado');
  end if;
  select count(*) into v_n from public.link_codigos where ip = v_ip and criado_em > now() - interval '10 minutes';
  if v_n >= 20 then return jsonb_build_object('status', 'limite'); end if;
  if not (v_email = any(r.emails)) then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_negado_email', null, jsonb_build_object('ip_pedido', v_ip));
    if array_length(r.emails, 1) = 1 then v_dica := left(r.emails[1], 1) || '***@' || split_part(r.emails[1], '@', 2); end if;
    return jsonb_build_object('status', 'nao_autorizado', 'dica', v_dica);
  end if;
  select count(*) into v_n from public.link_codigos where origem = p_origem and token = p_token and lower(email) = v_email and criado_em > now() - interval '15 minutes';
  if v_n >= 5 then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_limite');
    return jsonb_build_object('status', 'limite');
  end if;
  v_cod := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into public.link_codigos (origem, token, email, codigo_hash, expira_em, ip)
  values (p_origem, p_token, v_email, encode(extensions.digest(v_cod || ':' || p_token, 'sha256'), 'hex'), now() + interval '10 minutes', v_ip);
  perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_enviado', null, jsonb_build_object('ip_pedido', v_ip));
  return jsonb_build_object('status', 'enviado', 'codigo', v_cod, 'referencia', r.referencia, 'nome', r.nome);
end $f$;
revoke all on function public.link_pedir_codigo(text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_pedir_codigo(text, text, text, text) to service_role;

-- valida o codigo e abre uma sessao (publica: anon)
create or replace function public.link_validar_codigo(p_origem text, p_token text, p_email text, p_codigo text, p_ua text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare r record; c record; v_email text := lower(trim(coalesce(p_email, ''))); v_cod text := regexp_replace(coalesce(p_codigo, ''), '\D', '', 'g'); v_sess text; v_exp timestamptz;
begin
  select * into r from public.link_resolver(p_origem, p_token);
  if not found or not r.ativo then return jsonb_build_object('ok', false, 'motivo', 'indisponivel'); end if;
  if r.expira_em is not null and r.expira_em < now() then return jsonb_build_object('ok', false, 'motivo', 'expirado'); end if;
  select * into c from public.link_codigos
    where origem = p_origem and token = p_token and lower(email) = v_email and usado_em is null and expira_em > now()
    order by criado_em desc limit 1;
  if not found then
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_invalido', p_ua, jsonb_build_object('motivo', 'sem_codigo_ativo'));
    return jsonb_build_object('ok', false, 'motivo', 'invalido');
  end if;
  if c.tentativas >= 5 then return jsonb_build_object('ok', false, 'motivo', 'bloqueado'); end if;
  if c.codigo_hash <> encode(extensions.digest(v_cod || ':' || p_token, 'sha256'), 'hex') then
    update public.link_codigos set tentativas = tentativas + 1 where id = c.id;
    perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_invalido', p_ua, jsonb_build_object('tentativa', c.tentativas + 1));
    return jsonb_build_object('ok', false, 'motivo', 'invalido');
  end if;
  update public.link_codigos set usado_em = now() where id = c.id;
  v_sess := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := least(now() + interval '12 hours', coalesce(r.expira_em, now() + interval '12 hours'));
  insert into public.link_sessoes (origem, token, email, sessao_hash, expira_em)
  values (p_origem, p_token, v_email, encode(extensions.digest(v_sess, 'sha256'), 'hex'), v_exp);
  perform public.link_registrar(p_origem, p_token, r.ref_id, r.referencia, v_email, 'codigo_validado', p_ua);
  return jsonb_build_object('ok', true, 'sessao', v_sess, 'email', v_email, 'expira_em', v_exp);
end $f$;
revoke all on function public.link_validar_codigo(text, text, text, text, text) from public;
grant execute on function public.link_validar_codigo(text, text, text, text, text) to anon, authenticated;
