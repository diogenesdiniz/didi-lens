# didi-lens

Marketplace pessoal de plugins para o [Claude Code](https://code.claude.com).

## Plugins

| Plugin | O que faz |
|---|---|
| [`didi-trace`](plugins/didi-trace/README.md) | Dashboard local para inspecionar em detalhe, e ao vivo, as sessões do Claude Code: etapas, entradas e saídas completas de cada ferramenta, subagentes, tempos, tokens e erros. |

## Instalação

Dentro do Claude Code:

```
/plugin marketplace add diogenesdiniz/didi-lens
/plugin install didi-trace@didi-lens
```

## Desenvolvimento

Requer Node.js 18 ou superior e nenhuma dependência npm.

```bash
npm test
```
