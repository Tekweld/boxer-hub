
create or replace function comercial.hub_fn_definir_classe_comercial(p_cliente_id uuid, p_classe smallint)
returns jsonb
language plpgsql
security definer
set search_path to 'comercial', 'public'
as $function$
DECLARE
  v_role text;
  v_anterior smallint;
  v_row comercial.hub_clientes%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM comercial.hub_perfis
   WHERE user_id = auth.uid() AND ativo = true LIMIT 1;

  IF v_role IS NULL OR v_role != 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Apenas admin pode definir a classe comercial');
  END IF;

  IF p_classe IS NOT NULL AND p_classe NOT IN (1, 2, 3) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Classe invalida -- use 1, 2, 3 ou nulo (automatico)');
  END IF;

  SELECT classe_comercial INTO v_anterior FROM comercial.hub_clientes WHERE id = p_cliente_id;

  UPDATE comercial.hub_clientes
     SET classe_comercial = p_classe,
         atualizado_em = now()
   WHERE id = p_cliente_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cliente nao encontrado');
  END IF;

  INSERT INTO comercial.hub_log_alteracoes
    (usuario_id, tabela_ref, registro_id, campo, valor_anterior, valor_novo, acao)
  VALUES
    (auth.uid(), 'hub_clientes', p_cliente_id::text, 'classe_comercial',
     coalesce(v_anterior::text, 'automatico'), coalesce(p_classe::text, 'automatico'), 'update');

  RETURN jsonb_build_object('ok', true, 'cliente_id', p_cliente_id,
                            'nome', v_row.nome_exibicao, 'classe_comercial', v_row.classe_comercial);
END $function$;
