-- Expande o vocabulario de frete_modalidade pra cobrir as opcoes que o
-- Andre pediu (2026-11-25): CIF automatico, FOB, Retirada na Boxer, Carro
-- Boxer, Entrega com Caminhao Boxer (so SP). Antes so existia envio/retirada
-- (binario). Migra o dado historico pro vocabulario novo antes de apertar o
-- CHECK: envio->CIF, retirada->RETIRADA_BOXER (era a unica forma de "retirar"
-- antes, equivale ao novo RETIRADA_BOXER).
alter table comercial.hub_pedidos drop constraint if exists hub_pedidos_frete_modalidade_check;

update comercial.hub_pedidos set frete_modalidade = 'CIF' where frete_modalidade = 'envio';
update comercial.hub_pedidos set frete_modalidade = 'RETIRADA_BOXER' where frete_modalidade = 'retirada';

alter table comercial.hub_pedidos add constraint hub_pedidos_frete_modalidade_check
  check (frete_modalidade is null or frete_modalidade = any (array['CIF','FOB','RETIRADA_BOXER','CARRO_BOXER','CAMINHAO_BOXER_SP']));
