-- E-mail informado no orcamento para cliente que nao tinha e-mail no cadastro do ZEN (2026-11-27).
-- hub_clientes.email_principal e reescrito pelo sincronismo de clientes a partir do ZEN a cada rodada; este campo e
-- separado e o sincronismo NAO toca nele. O mesmo e-mail tambem e gravado no ZEN como contato (PersonContact EMAIL).
alter table comercial.hub_clientes add column if not exists email_complementar text;
comment on column comercial.hub_clientes.email_complementar is
  'E-mail informado pelo time no orcamento (cliente sem e-mail no ZEN). Nao e sobrescrito pelo sync de clientes.';

alter table comercial.hub_log_alteracoes drop constraint if exists hub_log_alteracoes_acao_check;
alter table comercial.hub_log_alteracoes add constraint hub_log_alteracoes_acao_check check (acao = any (array[
  'insert','update','delete','ativacao_cliente','rejeicao_onboarding','avancar_etapa','convite_criado','liberar_acesso',
  'reverter_pedido','ativar_usuario','desativar_usuario','resetar_senha','liberar_credito_rejeitado','cancelamento_onboarding',
  'convite_aceito','email_cliente']::text[]));

-- Grava o e-mail no cadastro do Hub. Chamada com o JWT do usuario (RLS/permissao: hub_pode_acessar_cliente).
create or replace function comercial.hub_fn_email_cliente(p_cliente uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_old text; v_erp text;
begin
  if v_email !~ '^\S+@\S+\.\S+$' then
    return jsonb_build_object('ok', false, 'erro', 'E-mail invalido');
  end if;
  if not comercial.hub_pode_acessar_cliente(p_cliente) then
    return jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  end if;
  select email_complementar, erp_cliente_id::text into v_old, v_erp from comercial.hub_clientes where id = p_cliente;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Cliente nao encontrado'); end if;
  update comercial.hub_clientes set email_complementar = v_email where id = p_cliente;
  insert into comercial.hub_log_alteracoes (usuario_id, usuario_email, tabela_ref, registro_id, campo, valor_anterior, valor_novo, acao)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), 'hub_clientes', p_cliente::text, 'email_complementar', v_old, v_email, 'email_cliente');
  return jsonb_build_object('ok', true, 'erp_cliente_id', v_erp, 'email', v_email);
end;
$$;
revoke all on function comercial.hub_fn_email_cliente(uuid, text) from public, anon;
grant execute on function comercial.hub_fn_email_cliente(uuid, text) to authenticated;
