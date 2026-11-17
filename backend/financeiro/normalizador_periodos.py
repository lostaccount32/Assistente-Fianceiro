"""Conversão de valores entre periodicidades e orçamento diário médio."""

from datetime import date
from decimal import Decimal

from .schemas import NormalizacaoPeriodoInput, NormalizacaoPeriodoOutput, Periodicidade
from .utils import arredondar_moeda, dias_no_ano, dias_restantes_ciclo, dias_totais_ciclo


def periodos_por_ano(periodicidade: Periodicidade, ref: date) -> Decimal:
    """Quantidade de períodos em um ano: diária = dias do ano, semanal = 52,
    quinzenal = 24, mensal = 12, anual = 1."""
    return Decimal({
        Periodicidade.DIARIA: dias_no_ano(ref),
        Periodicidade.SEMANAL: 52,
        Periodicidade.QUINZENAL: 24,
        Periodicidade.MENSAL: 12,
        Periodicidade.ANUAL: 1,
    }[periodicidade])


def normalizar_periodo(entrada: NormalizacaoPeriodoInput) -> NormalizacaoPeriodoOutput:
    """valor_convertido = valor * períodos/ano(origem) / períodos/ano(destino).

    orcamento_diario_medio = valor_convertido / dias totais do ciclo de destino
    que contém `data_referencia`. Divide-se uma única vez, arredonda-se no fim.
    """
    ref = entrada.data_referencia
    anual = entrada.valor * periodos_por_ano(entrada.periodo_origem, ref)
    convertido = anual / periodos_por_ano(entrada.periodo_destino, ref)

    totais = dias_totais_ciclo(entrada.periodo_destino, ref)
    restantes = dias_restantes_ciclo(entrada.periodo_destino, ref)
    convertido_arred = arredondar_moeda(convertido)

    return NormalizacaoPeriodoOutput(
        valor_original=entrada.valor,
        valor_convertido=convertido_arred,
        orcamento_diario_medio=arredondar_moeda(convertido / totais),
        dias_restantes_ciclo=restantes,
        dias_totais_ciclo=totais,
    )


if __name__ == "__main__":
    P = Periodicidade
    ref = date(2026, 11, 16)  # novembro: 30 dias, 15 restantes (inclui hoje)

    def conv(v, o, d, r=ref):
        return normalizar_periodo(NormalizacaoPeriodoInput(
            valor=Decimal(v), periodo_origem=o, periodo_destino=d, data_referencia=r))

    r = conv("3000.00", P.MENSAL, P.MENSAL)
    assert r.valor_convertido == Decimal("3000.00")
    assert r.orcamento_diario_medio == Decimal("100.00")      # 3000/30
    assert (r.dias_totais_ciclo, r.dias_restantes_ciclo) == (30, 15)

    assert conv("1200.00", P.MENSAL, P.ANUAL).valor_convertido == Decimal("14400.00")
    assert conv("1200.00", P.MENSAL, P.QUINZENAL).valor_convertido == Decimal("600.00")
    assert conv("100.00", P.ANUAL, P.MENSAL).valor_convertido == Decimal("8.33")     # dízima 8.3333
    assert conv("100.00", P.ANUAL, P.MENSAL).orcamento_diario_medio == Decimal("0.28")
    assert conv("10.00", P.SEMANAL, P.MENSAL).valor_convertido == Decimal("43.33")   # 520/12
    assert conv("0.05", P.DIARIA, P.ANUAL, date(2026, 6, 1)).valor_convertido == Decimal("18.25")
    assert conv("0.05", P.DIARIA, P.ANUAL, date(2024, 6, 1)).valor_convertido == Decimal("18.30")  # bissexto
    assert conv("100.00", P.QUINZENAL, P.SEMANAL).valor_convertido == Decimal("46.15")  # 2400/52
    # half-up exato: 0.01/12 anual->mensal... 0.06 anual = 0.005 mensal -> 0.01
    assert conv("0.06", P.ANUAL, P.MENSAL).valor_convertido == Decimal("0.01")
    # fevereiro bissexto: ciclo de 29 dias
    f = conv("2900.00", P.MENSAL, P.MENSAL, date(2024, 2, 29))
    assert f.orcamento_diario_medio == Decimal("100.00") and f.dias_restantes_ciclo == 1
    # destino diário: ciclo de 1 dia
    d = conv("3650.00", P.ANUAL, P.DIARIA, date(2026, 1, 1))
    assert d.valor_convertido == Decimal("10.00") and d.orcamento_diario_medio == Decimal("10.00")
    print("normalizador_periodos OK")
