"""Análise da regra 50/30/20: valores e percentuais atuais vs. ideais."""

from decimal import Decimal

from .schemas import Analise503020Input, Analise503020Output, DespesaItem, DetalhePilar, Pilar503020
from .utils import ZERO, arredondar_moeda, arredondar_percentual, percentual

_IDEAIS: tuple[tuple[Pilar503020, Decimal], ...] = (
    (Pilar503020.NECESSIDADES, Decimal("50")),
    (Pilar503020.DESEJOS, Decimal("30")),
    (Pilar503020.POUPANCA_DIVIDAS, Decimal("20")),
)


def analisar_50_30_20(entrada: Analise503020Input) -> Analise503020Output:
    """Compara gasto por pilar com 50/30/20 da renda.

    - `valor_ideal` dos dois primeiros pilares é arredondado half-up; o da
      poupança é o resto (renda - os dois), para a soma dos ideais sempre
      fechar exatamente na renda.
    - `desvio_valor`/`desvio_percentual` = atual - ideal (positivo = acima do
      ideal, conforme o schema).
    - "Desvio adverso": acima do ideal em necessidades/desejos (estourou o
      teto) e ABAIXO do ideal em poupança/dívidas (poupou menos que o piso).
      `pilar_mais_critico` é o pilar de maior desvio adverso em p.p.
      (None se não houver) e `dentro_do_equilibrio` é True sem nenhum adverso.
    - Despesas com valor pendente não entram na soma.
    """
    renda = entrada.renda_mensal
    soma: dict[Pilar503020, Decimal] = {p: ZERO for p, _ in _IDEAIS}
    for d in entrada.despesas:
        if not d.valor_pendente_informacao:
            soma[d.pilar] += d.valor

    ideais: dict[Pilar503020, Decimal] = {}
    acumulado = ZERO
    for pilar, pct in _IDEAIS[:-1]:
        ideais[pilar] = arredondar_moeda(renda * pct / 100)
        acumulado += ideais[pilar]
    ideais[Pilar503020.POUPANCA_DIVIDAS] = arredondar_moeda(renda - acumulado)

    pilares: list[DetalhePilar] = []
    pior: tuple[tuple[Decimal, Decimal], Pilar503020] | None = None
    for pilar, pct in _IDEAIS:
        atual = arredondar_moeda(soma[pilar])
        pct_atual = percentual(atual, renda)
        desvio_pct = arredondar_percentual(pct_atual - pct)
        desvio_val = arredondar_moeda(atual - ideais[pilar])
        pilares.append(DetalhePilar(
            pilar=pilar, percentual_ideal=pct, valor_ideal=ideais[pilar],
            valor_atual=atual, percentual_atual=pct_atual,
            desvio_valor=desvio_val, desvio_percentual=desvio_pct,
        ))
        adverso_val = -desvio_val if pilar == Pilar503020.POUPANCA_DIVIDAS else desvio_val
        if adverso_val > 0:
            adverso_pct = -desvio_pct if pilar == Pilar503020.POUPANCA_DIVIDAS else desvio_pct
            chave = (adverso_pct, adverso_val)
            if pior is None or chave > pior[0]:
                pior = (chave, pilar)

    return Analise503020Output(
        renda_base=renda,
        pilares=pilares,
        pilar_mais_critico=pior[1] if pior else None,
        dentro_do_equilibrio=pior is None,
    )


if __name__ == "__main__":
    D = Decimal
    N, W, S = Pilar503020.NECESSIDADES, Pilar503020.DESEJOS, Pilar503020.POUPANCA_DIVIDAS

    def item(v, p):
        return DespesaItem(descricao="x", valor=D(v), pilar=p)

    # perfeito
    r = analisar_50_30_20(Analise503020Input(renda_mensal=D("1000"), despesas=[
        item("500", N), item("300", W), item("200", S)]))
    assert r.dentro_do_equilibrio and r.pilar_mais_critico is None
    assert [p.valor_ideal for p in r.pilares] == [D("500.00"), D("300.00"), D("200.00")]
    assert all(p.desvio_valor == 0 and p.desvio_percentual == 0 for p in r.pilares)

    # desejos estouraram, poupança abaixo
    r = analisar_50_30_20(Analise503020Input(renda_mensal=D("5000"), despesas=[
        item("2000", N), item("2000", W), item("100", S)]))
    n, w, s = r.pilares
    assert n.valor_atual == D("2000.00") and n.desvio_valor == D("-500.00") and n.percentual_atual == D("40.00")
    assert w.valor_ideal == D("1500.00") and w.desvio_valor == D("500.00") and w.desvio_percentual == D("10.00")
    assert s.desvio_valor == D("-900.00") and s.percentual_atual == D("2.00")
    assert r.pilar_mais_critico == S          # 18 p.p. abaixo > 10 p.p. acima
    assert not r.dentro_do_equilibrio

    # necessidades estouradas é o pior
    r = analisar_50_30_20(Analise503020Input(renda_mensal=D("1000"), despesas=[
        item("900", N), item("50", W), item("50", S)]))
    assert r.pilar_mais_critico == N

    # centavos: ideais sempre somam a renda (33.33 -> 16.665/9.999/6.666)
    r = analisar_50_30_20(Analise503020Input(renda_mensal=D("33.33"), despesas=[]))
    ideais = [p.valor_ideal for p in r.pilares]
    assert ideais == [D("16.67"), D("10.00"), D("6.66")] and sum(ideais) == D("33.33")
    assert r.pilar_mais_critico == S and not r.dentro_do_equilibrio  # sem poupança

    # despesa sem valor é ignorada
    r = analisar_50_30_20(Analise503020Input(renda_mensal=D("1000"), despesas=[
        DespesaItem(descricao="?", valor=D("0"), valor_pendente_informacao=True),
        item("500", N), item("300", W), item("200", S)]))
    assert r.dentro_do_equilibrio
    # dízima de percentual
    r = analisar_50_30_20(Analise503020Input(renda_mensal=D("3"), despesas=[item("1", N)]))
    assert r.pilares[0].percentual_atual == D("33.33")
    print("analisador_50_30_20 OK")
