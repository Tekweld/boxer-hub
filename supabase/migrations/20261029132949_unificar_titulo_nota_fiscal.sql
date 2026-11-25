-- Unifica Titulos + Notas Fiscais numa visao so no financeiro.html (feedback
-- Andre, 2026-10-29): "para a visao do cliente e uma coisa so".
--
-- Faltava um jeito de ligar titulo -> NF de forma estavel. O Zen tem isso
-- (financial.Receivable.invoice -> fiscal.OutgoingInvoice), mas o Hub so
-- guardava invoice.id de passagem, sem gravar. hub_titulos.nota_fiscal_id
-- fecha esse buraco -- preenchido pelo sync (sincronizarTitulos, api/
-- sync-financeiro.js) e por backfill_pedido_titulo para linhas antigas.
--
-- A NF e a base da visao unificada (nao o titulo): toda venda gera NF, mas
-- titulo some da tabela quando fica SETTLED (sync so traz status==APPROVED).
-- Juntar pela NF garante que documento antigo/pago continua encontravel.
alter table comercial.hub_titulos
  add column nota_fiscal_id uuid references comercial.hub_notas_fiscais(id);

create index if not exists idx_hub_titulos_nota_fiscal_id
  on comercial.hub_titulos(nota_fiscal_id);
