"""Balanço orçamentário: saldo líquido, comprometimento e dados ausentes."""

from decimal import Decimal

from .schemas import (
    BalancoOrcamentarioInput,
    BalancoOrcamentarioOutput,
    DespesaItem,
    Pilar503020,
)
from .utils import ZERO, arredondar_moeda, percentual


def calcular_balanco(entrada: BalancoOrcamentarioInput) -> BalancoOrcamentarioOutput:
    """saldo_disponivel = renda - soma das despesas com valor informado.

    - Despesas com `valor_pendente_informacao=True` NÃO entram na soma; são
      listadas em `despesas_sem_valor_citadas` e tornam `dados_completos` False.
    - `renda_mensal` ausente ou zero (percentual indefinido) entra em `campos_faltantes`
      (ausente conta como 0); lista de despesas vazia também.
    - `percentual_comprometido` = despesas / renda * 100 (0.00 se renda = 0).
    - `divergencia_saldo_informado` = saldo informado - saldo calculado
      (positivo: o usuário acredita ter mais do que o calculado).
    - `gasto_pretendido` não altera o balanço (é avaliado pelos simuladores).
    """
    faltantes: list[str] = []
    if entrada.renda_mensal is None or entrada.renda_mensal == 0:
        faltantes.append("renda_mensal")
    if not entrada.despesas:
        faltantes.append("despesas")

    sem_valor = [d.descricao for d in entrada.despesas if d.valor_pendente_informacao]
    renda = entrada.renda_mensal if entrada.renda_mensal is not None else ZERO
    total = arredondar_moeda(sum(
        (d.valor for d in entrada.despesas if not d.valor_pendente_informacao), ZERO))
    saldo = arredondar_moeda(renda - total)

    divergencia = None
    if entrada.saldo_informado_usuario is not None:
        divergencia = arredondar_moeda(entrada.saldo_informado_usuario - saldo)

    return BalancoOrcamentarioOutput(
        dados_completos=not faltantes and not sem_valor,
        campos_faltantes=faltantes,
        despesas_sem_valor_citadas=sem_valor,
        renda_mensal=renda,
        total_despesas=total,
        saldo_disponivel=saldo,
        percentual_comprometido=percentual(total, renda),
        divergencia_saldo_informado=divergencia,
    )


if __name__ == "__main__":
    D = lambda s: Decimal(s)

    r = calcular_balanco(BalancoOrcamentarioInput(
        renda_mensal=D("5000.00"),
        despesas=[DespesaItem(descricao="Aluguel", valor=D("1500.00")),
                  DespesaItem(descricao="Mercado", valor=D("1234.56"))],
        saldo_informado_usuario=D("2265.44"),
    ))
    assert r.dados_completos and r.campos_faltantes == []
    assert r.total_despesas == D("2734.56") and r.saldo_disponivel == D("2265.44")
    assert r.percentual_comprometido == D("54.69")             # 54.6912
    assert r.divergencia_saldo_informado == D("0.00")

    # divergência de 1 centavo
    r = calcular_balanco(BalancoOrcamentarioInput(
        renda_mensal=D("1000.00"),
        despesas=[DespesaItem(descricao="X", valor=D("333.33"))],
        saldo_informado_usuario=D("666.68")))
    assert r.saldo_disponivel == D("666.67") and r.divergencia_saldo_informado == D("0.01")
    # divergência negativa
    r = calcular_balanco(BalancoOrcamentarioInput(
        renda_mensal=D("1000.00"), despesas=[DespesaItem(descricao="X", valor=D("100"))],
        saldo_informado_usuario=D("800")))
    assert r.divergencia_saldo_informado == D("-100.00")

    # renda ausente + despesa sem valor
    r = calcular_balanco(BalancoOrcamentarioInput(despesas=[
        DespesaItem(descricao="umas assinaturas", valor=D("0"), valor_pendente_informacao=True),
        DespesaItem(descricao="Luz", valor=D("200.00"))]))
    assert not r.dados_completos
    assert r.campos_faltantes == ["renda_mensal"]
    assert r.despesas_sem_valor_citadas == ["umas assinaturas"]
    assert r.total_despesas == D("200.00") and r.saldo_disponivel == D("-200.00")
    assert r.percentual_comprometido == D("0.00") and r.divergencia_saldo_informado is None

    # renda zero também é dado faltante
    r = calcular_balanco(BalancoOrcamentarioInput(renda_mensal=D("0"), despesas=[DespesaItem(descricao="X", valor=D("10"))]))
    assert r.campos_faltantes == ["renda_mensal"] and r.percentual_comprometido == D("0.00")

    # tudo vazio
    r = calcular_balanco(BalancoOrcamentarioInput())
    assert r.campos_faltantes == ["renda_mensal", "despesas"] and not r.dados_completos

    # despesas acima da renda
    r = calcular_balanco(BalancoOrcamentarioInput(
        renda_mensal=D("1000"), despesas=[DespesaItem(descricao="Y", valor=D("1500"))]))
    assert r.saldo_disponivel == D("-500.00") and r.percentual_comprometido == D("150.00")
    print("balanco_orcamentario OK")
