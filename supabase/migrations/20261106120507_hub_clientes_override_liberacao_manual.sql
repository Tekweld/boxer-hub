-- Achado em auditoria (2026-11-04): "Liberar acesso" (hub_fn_liberar_cliente)
-- zera bloqueado/status_cadastro/tags no Hub, mas o ZEN nao aceita update de
-- Person (so leitura) -- a tag 'blocked' continua existindo LA, entao o
-- proximo sync-zen-clientes (agora de 2 em 2h no expediente) le a tag de
-- novo e desfaz a liberacao, sem avisar ninguem. Esta coluna marca "admin
-- decidiu liberar apesar do ZEN ainda dizer bloqueado" -- o sync passa a
-- respeitar essa decisao em vez de sobrescrever (so some sozinha quando o
-- ZEN de verdade parar de mandar a tag 'blocked', sinal de que alguem
-- desbloqueou la tambem).
alter table comercial.hub_clientes
  add column if not exists bloqueio_liberado_manualmente boolean default false;

create or replace function comercial.hub_fn_liberar_cliente(p_cliente_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'comercial', 'public'
as $function$
DECLARE
  v_role text;
  v_row  comercial.hub_clientes%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM comercial.hub_perfis
   WHERE user_id = auth.uid() AND ativo = true LIMIT 1;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Apenas admin ou manager pode liberar');
  END IF;

  UPDATE comercial.hub_clientes
     SET bloqueado = false,
         status_cadastro = 'ativo',
         tags = array_remove(tags, 'blocked'),
         bloqueio_liberado_manualmente = true,
         atualizado_em = now()
   WHERE id = p_cliente_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cliente nao encontrado');
  END IF;

  INSERT INTO comercial.hub_log_alteracoes
    (usuario_id, tabela_ref, registro_id, campo, valor_anterior, valor_novo, acao)
  VALUES
    (auth.uid(), 'hub_clientes', p_cliente_id::text, 'status_cadastro',
     'suspenso', 'ativo', 'liberar_acesso');

  RETURN jsonb_build_object('ok', true, 'cliente_id', p_cliente_id,
                            'nome', v_row.nome_exibicao);
END $function$;
