-- Alinha hub_fn_reverter_pedido ao padrao das demais funcoes SECURITY DEFINER
-- do schema: search_path vazio, tudo qualificado. Evita que a funcao possa ser
-- sequestrada por um schema no path do chamador.
ALTER FUNCTION comercial.hub_fn_reverter_pedido(uuid) SET search_path = '';