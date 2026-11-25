-- hub_politica_parametros.valor e `numeric`, entao todo parametro chega no
-- jsonb como texto com decimais ("3.00", "10.00"). O cast direto ->>'x'::int
-- estoura com 22P02 ("invalid input syntax for type integer: 3.00"), e como
-- isso esta no ramo de boleto/duplicata, TODO pedido em boleto quebrava ao
-- submeter. Achado em 2026-09-07 testando pedido com boleto 3x.
--
-- Reescreve a definicao atual trocando o cast, em vez de recriar a funcao
-- inteira na mao: 8,6 KB de corpo, e recriar de memoria arrisca perder trecho.
do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'comercial' and p.proname = 'hub_fn_validar_politica';

  if v_def is null then
    raise exception 'comercial.hub_fn_validar_politica nao encontrada';
  end if;

  if position(')::numeric::int' in v_def) > 0 then
    raise notice 'ja corrigido, nada a fazer';
    return;
  end if;

  v_def := replace(v_def, ')::int', ')::numeric::int');
  execute v_def;
end
$mig$;