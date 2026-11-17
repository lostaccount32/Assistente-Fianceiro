"""Rebalanceamento: cortes nas folgas para cobrir um déficit."""

from decimal import Decimal

from .schemas import (
    CategoriaFolga,
    EstrategiaRebalanceamento,
    Pilar503020,
    PlanoCorteCategoria,
    RebalanceamentoInput,
    RebalanceamentoOutput,
)
from .utils import ZERO, arredondar_moeda, de_centavos, para_centavos

# Ordem de sacrifício em PRIORIZAR_DESEJOS: desejos, depois necessidades,
# poupança por último (é o pilar que se quer proteger por mais tempo).
_ORDEM_PRIORIDADE = (Pilar503020.DESEJOS, Pilar503020.NECESSIDADES, Pilar503020.POUPANCA_DIVIDAS)


def _ratear(valor: int, folgas: list[int]) -> list[int]:
    """Divide `valor` centavos proporcionalmente a `folgas` (centavos) sem
    perder centavos (maior resto). Exige valor <= sum(folgas); nunca excede
    a folga individual."""
    total = sum(folgas)
    if total == 0 or valor == 0:
        return [0] * len(folgas)
    if valor >= total:
        return list(folgas)
    partes = [valor * f // total for f in folgas]
    restos = [valor * f % total for f in folgas]
    sobra = valor - sum(partes)
    ordem = sorted(range(len(folgas)), key=lambda i: (-restos[i], i))
    for i in ordem[:sobra]:
        partes[i] += 1
    return partes


def rebalancear_orcamento(entrada: RebalanceamentoInput) -> RebalanceamentoOutput:
    """Corta apenas folgas positivas (`saldo_disponivel` <= 0 é ignorado).

    - PROPORCIONAL_GERAL: o déficit é rateado entre todas as categorias na
      proporção de suas folgas.
    - PRIORIZAR_DESEJOS: consome por tier (desejos -> necessidades ->
      poupança); dentro do tier, proporcional às folgas.
    Cortes nunca ultrapassam a folga; o rateio em centavos é exato.
    `novo_teto_diario` = novo limite disponível / dias restantes.
    `economia_diaria_necessaria` = déficit / dias restantes.
    `cortes_sugeridos` lista só categorias com corte > 0.
    """
    deficit = para_centavos(entrada.valor_deficit_compensar)
    cats = entrada.categorias_disponiveis
    folgas = [max(para_centavos(c.saldo_disponivel), 0) for c in cats]
    total_folga = sum(folgas)
    cortes = [0] * len(cats)

    if entrada.estrategia == EstrategiaRebalanceamento.PROPORCIONAL_GERAL:
        cortes = _ratear(min(deficit, total_folga), folgas)
    else:
        restante = deficit
        for pilar in _ORDEM_PRIORIDADE:
            idx = [i for i, c in enumerate(cats) if c.pilar == pilar and folgas[i] > 0]
            if not idx or restante == 0:
                continue
            tier = [folgas[i] for i in idx]
            usado = min(restante, sum(tier))
            for i, parte in zip(idx, _ratear(usado, tier)):
                cortes[i] = parte
            restante -= usado

    total_cortado = sum(cortes)
    dias = entrada.dias_restantes_periodo
    planos: list[PlanoCorteCategoria] = []
    for c, folga, corte in zip(cats, folgas, cortes):
        if corte <= 0:
            continue
        novo = de_centavos(folga - corte)
        planos.append(PlanoCorteCategoria(
            categoria=c.categoria,
            pilar=c.pilar,
            folga_anterior=de_centavos(folga),
            valor_cortar=de_centavos(corte),
            novo_limite_disponivel=novo,
            novo_teto_diario=arredondar_moeda(novo / dias),
        ))

    return RebalanceamentoOutput(
        deficit_total=entrada.valor_deficit_compensar,
        total_folga_encontrada=de_centavos(total_folga),
        deficit_coberto_integralmente=total_cortado >= deficit,
        saldo_descoberto_restante=de_centavos(deficit - total_cortado),
        economia_diaria_necessaria=arredondar_moeda(entrada.valor_deficit_compensar / dias),
        cortes_sugeridos=planos,
    )


if __name__ == "__main__":
    D = Decimal
    N, W, S = Pilar503020.NECESSIDADES, Pilar503020.DESEJOS, Pilar503020.POUPANCA_DIVIDAS

    def cat(nome, pilar, folga, limite="1000", gasto=None):
        gasto = gasto if gasto is not None else D(limite) - D(folga)
        return CategoriaFolga(categoria=nome, pilar=pilar, limite_meta=D(limite),
                              gasto_atual=D(gasto), saldo_disponivel=D(folga))

    def reb(deficit, dias, cats, est=EstrategiaRebalanceamento.PRIORIZAR_DESEJOS):
        return rebalancear_orcamento(RebalanceamentoInput(
            valor_deficit_compensar=D(deficit), dias_restantes_periodo=dias,
            categorias_disponiveis=cats, estrategia=est))

    base = [cat("Lazer", W, "100"), cat("Roupas", W, "50"), cat("Mercado", N, "200"), cat("Reserva", S, "80")]

    # priorizar desejos: 120 sai só de desejos, proporcional (80 / 40)
    r = reb("120", 10, base)
    c = {p.categoria: p for p in r.cortes_sugeridos}
    assert set(c) == {"Lazer", "Roupas"}
    assert c["Lazer"].valor_cortar == D("80.00") and c["Roupas"].valor_cortar == D("40.00")
    assert c["Lazer"].novo_limite_disponivel == D("20.00") and c["Lazer"].novo_teto_diario == D("2.00")
    assert c["Roupas"].novo_teto_diario == D("1.00")
    assert r.deficit_coberto_integralmente and r.saldo_descoberto_restante == D("0.00")
    assert r.total_folga_encontrada == D("430.00") and r.economia_diaria_necessaria == D("12.00")

    # transborda para necessidades após esgotar desejos
    r = reb("250", 5, base)
    c = {p.categoria: p for p in r.cortes_sugeridos}
    assert c["Lazer"].valor_cortar == D("100.00") and c["Roupas"].valor_cortar == D("50.00")
    assert c["Mercado"].valor_cortar == D("100.00") and "Reserva" not in c
    assert c["Lazer"].novo_teto_diario == D("0.00")
    assert c["Mercado"].novo_limite_disponivel == D("100.00") and c["Mercado"].novo_teto_diario == D("20.00")

    # déficit maior que toda a folga
    r = reb("500", 3, base)
    assert not r.deficit_coberto_integralmente and r.saldo_descoberto_restante == D("70.00")
    assert sum(p.valor_cortar for p in r.cortes_sugeridos) == D("430.00")
    assert r.economia_diaria_necessaria == D("166.67")                  # dízima 166.666

    # proporcional geral, dízima: 100,00 entre 3 folgas iguais fecha em 100,00
    tres = [cat("A", W, "100"), cat("B", N, "100"), cat("C", S, "100")]
    r = reb("100", 7, tres, EstrategiaRebalanceamento.PROPORCIONAL_GERAL)
    vals = [p.valor_cortar for p in r.cortes_sugeridos]
    assert sorted(vals) == [D("33.33"), D("33.33"), D("33.34")] and sum(vals) == D("100.00")
    assert r.deficit_coberto_integralmente

    # proporcional com pesos diferentes: 0,01 de déficit vai para a maior folga
    r = reb("0.01", 1, [cat("A", W, "10"), cat("B", N, "90")], EstrategiaRebalanceamento.PROPORCIONAL_GERAL)
    assert [(p.categoria, p.valor_cortar) for p in r.cortes_sugeridos] == [("B", D("0.01"))]

    # folgas <= 0 são ignoradas (categoria estourada não é cortada)
    r = reb("30", 2, [cat("Estourada", W, "-40"), cat("Zerada", W, "0"), cat("Ok", W, "50")])
    assert [p.categoria for p in r.cortes_sugeridos] == ["Ok"]
    assert r.total_folga_encontrada == D("50.00") and r.cortes_sugeridos[0].novo_teto_diario == D("10.00")

    # sem nenhuma folga
    r = reb("10", 1, [cat("X", W, "0")])
    assert r.cortes_sugeridos == [] and not r.deficit_coberto_integralmente
    assert r.saldo_descoberto_restante == D("10.00")
    print("rebalanceador_orcamento OK")
