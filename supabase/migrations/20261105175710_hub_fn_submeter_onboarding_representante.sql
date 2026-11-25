-- Modulo novo pedido pelo Andre, 2026-11-06: representante cadastra uma
-- revenda nova DENTRO do Hub (ja logado), em vez de so o cliente preencher
-- o formulario publico (onboarding.html). Mesma tabela/pipeline de sempre
-- (hub_onboarding), so que com o vendedor ja vinculado de cara -- a funcao
-- publica (hub_fn_submeter_onboarding) recebia p_representante_nome mas
-- NUNCA gravava nada com ele (parametro morto, achado nesta investigacao).
-- Funcao separada (nao sobrescreve a publica) pra nao arriscar o fluxo de
-- autosservico do cliente, que ja esta em producao.
create or replace function comercial.hub_fn_submeter_onboarding_representante(
  p_cnpj text,
  p_razao_social text,
  p_nome_fantasia text,
  p_inscricao_estadual text,
  p_contato_nome text,
  p_contato_email text,
  p_contato_telefone text,
  p_enderecos jsonb,
  p_contatos jsonb,
  p_respostas_classificacao jsonb,
  p_representante_id uuid,
  p_classificacao text default null,
  p_regiao text default null,
  p_documentos jsonb default '[]'::jsonb,
  p_aceita_faturamento_parcial boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
  v_existe boolean;
  v_uid uuid := auth.uid();
  v_perfil record;
begin
  -- So representante com perfil ativo pode chamar -- security definer
  -- nao herda RLS, a checagem tem que ser explicita aqui.
  select tipo, representante_id into v_perfil
    from comercial.hub_perfis
   where user_id = v_uid and ativo = true;

  if v_perfil.tipo is distinct from 'representante' then
    return jsonb_build_object('ok', false, 'erro', 'Apenas representante pode usar este cadastro.');
  end if;
  if p_representante_id is distinct from v_perfil.representante_id then
    return jsonb_build_object('ok', false, 'erro', 'Representante informado nao confere com o usuario logado.');
  end if;

  select exists(select 1 from comercial.hub_onboarding
    where cnpj = p_cnpj and ativo = true and etapa_atual not in ('rejeitado')) into v_existe;
  if v_existe then
    return jsonb_build_object('ok', false, 'erro', 'Ja existe um cadastro em andamento para este CNPJ.');
  end if;

  select exists(select 1 from comercial.hub_clientes
    where cnpj = p_cnpj and ativo = true) into v_existe;
  if v_existe then
    return jsonb_build_object('ok', false, 'erro', 'Este CNPJ ja esta cadastrado como cliente ativo.');
  end if;

  select exists(select 1 from auth.users where email = p_contato_email) into v_existe;
  if v_existe then
    return jsonb_build_object('ok', false, 'erro', 'Este email ja possui uma conta no sistema.');
  end if;

  insert into comercial.hub_onboarding (
    cnpj, razao_social, nome_fantasia, inscricao_estadual,
    contato_nome, contato_email, contato_telefone,
    enderecos, contatos, respostas_classificacao,
    classificacao, regiao, representante_id,
    documentos_base64,
    aceita_faturamento_parcial,
    etapa_atual, criado_por_tipo
  ) values (
    p_cnpj, p_razao_social, p_nome_fantasia, p_inscricao_estadual,
    p_contato_nome, p_contato_email, p_contato_telefone,
    p_enderecos, p_contatos, p_respostas_classificacao,
    p_classificacao, p_regiao, p_representante_id,
    p_documentos,
    coalesce(p_aceita_faturamento_parcial, false),
    'validacao_ia', 'representante'
  ) returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;
