alter table comercial.orcamentos add column if not exists dias_pagamento jsonb;
comment on column comercial.orcamentos.dias_pagamento is 'Plano de prazo do boleto em dias (ex.: [28,56,84]), espelhando comercial.hub_planos_prazo_boleto -- so para exibicao textual, nunca "Nx". Null quando pagamento_tipo=avista ou quando o rascunho antigo nao tinha o plano.';
