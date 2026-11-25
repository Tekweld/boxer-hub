-- trg_hub_liberar_credito_pedido (2026-08-28) devolvia credito DIRETO na filial do pedido,
-- sem teto e sem grupo, a cada mudanca para 'cancelado' OU 'rejeitado'. Depois disso
-- surgiram funcoes que ja devolvem pelo helper de grupo (hub_fn_liberar_credito_rejeitado)
-- ou nao tem o que devolver (rejeitar pedido em analise: nada foi reservado). Resultado
-- medido em 2026-11-25 ao limpar pedidos de teste: devolucao EM DOBRO -- filial com
-- limite 0 passou a ter R$ 3.171,88 "disponivel" e outra passou do proprio limite.
--
-- Agora: so 'cancelado' (nenhuma tela cancela pedido hoje, fica de rede de seguranca),
-- so de estados que de fato reservaram (em_analise NAO reserva), so pedido criado no Hub
-- (origem 'erp' nunca reservou) e pelo helper de grupo, que respeita o teto.
-- 'rejeitado' fica por conta das funcoes explicitas.
create or replace function comercial.hub_trg_liberar_credito_pedido()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if OLD.status is distinct from NEW.status
     and OLD.status = any (array['submetido', 'aprovado', 'em_separacao', 'faturado', 'enviado', 'entregue'])
     and NEW.status = 'cancelado'
     and coalesce(OLD.origem, '') <> 'erp' then
    perform comercial.hub_fn_ajustar_credito_grupo(NEW.cliente_id, coalesce(OLD.valor_total, 0));
  end if;
  return NEW;
end;
$$;
