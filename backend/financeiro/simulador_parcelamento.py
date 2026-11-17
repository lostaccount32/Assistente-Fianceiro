"""Simulação de parcelamento (sem juros ou Tabela Price) de 2x a max_parcelas."""

from decimal import Decimal, localcontext

from .schemas import (
    OpcaoParcela,
    SimulacaoParcelamentoInput,
    SimulacaoParcelamentoOutput,
)
from .utils import ZERO, arredondar_moeda, percentual


def _total_e_pmt_exatos(compra: Decimal, taxa_pct: Decimal, n: int) -> tuple[Decimal, Decimal]:
    """(prestação exata, total exato) sem arredondar. Tabela Price:
    PMT = PV * i / (1 - (1+i)^-n); com i = 0, PMT = PV / n."""
    if taxa_pct == 0:
        return compra / n, compra
    with localcontext() as ctx:
        ctx.prec = 60
        i = taxa_pct / 100
        pmt = compra * i / (1 - (1 + i) ** -n)
        return pmt, pmt * n


def simular_parcelamento(entrada: SimulacaoParcelamentoInput) -> SimulacaoParcelamentoOutput:
    """Gera uma opção para cada n em [2, max_parcelas].

    Centavos: as n-1 primeiras parcelas valem `valor_parcela` (exato/n
    arredondado half-up) e a ÚLTIMA absorve a diferença, de modo que
    `valor_total_pago` = round(total exato) e a soma das parcelas fecha sem
    resto (ex.: 100,00 em 3x = 33,33 + 33,33 + 33,34).

    Viabilidade usa a MAIOR parcela (pior mês), então 1 centavo a mais na
    última parcela pode tornar a opção inviável. `saldo_mensal_restante` e
    `novo_percentual_comprometimento` também refletem esse pior mês.
    `menor_parcelamento_viavel` é a viável com menos parcelas.
    """
    folga = arredondar_moeda(entrada.renda_mensal - entrada.total_despesas_atuais)
    opcoes: list[OpcaoParcela] = []

    for n in range(2, entrada.max_parcelas + 1):
        pmt, total_exato = _total_e_pmt_exatos(entrada.valor_compra, entrada.taxa_juros_mensal_percentual, n)
        parcela = arredondar_moeda(pmt)
        total = arredondar_moeda(total_exato)
        ultima = total - parcela * (n - 1)
        maior = max(parcela, ultima)

        saldo = folga - maior
        opcoes.append(OpcaoParcela(
            numero_parcelas=n,
            valor_parcela=parcela,
            valor_total_pago=total,
            custo_juros=total - entrada.valor_compra,
            saldo_mensal_restante=saldo,
            novo_percentual_comprometimento=percentual(
                entrada.total_despesas_atuais + maior, entrada.renda_mensal),
            viavel_no_orcamento=saldo >= ZERO,
        ))

    menor = next((o for o in opcoes if o.viavel_no_orcamento), None)
    return SimulacaoParcelamentoOutput(
        folga_mensal_atual=folga,
        opcoes=opcoes,
        menor_parcelamento_viavel=menor,
        existe_opcao_viavel=menor is not None,
    )


def parcelas_detalhadas(valor_compra: Decimal, taxa_juros_mensal_percentual: Decimal, n: int) -> list[Decimal]:
    """Lista das n parcelas reais (última ajustada). Soma = valor_total_pago."""
    pmt, total_exato = _total_e_pmt_exatos(valor_compra, taxa_juros_mensal_percentual, n)
    parcela = arredondar_moeda(pmt)
    return [parcela] * (n - 1) + [arredondar_moeda(total_exato) - parcela * (n - 1)]


if __name__ == "__main__":
    D = Decimal

    def sim(renda, desp, compra, taxa="0", mx=12):
        return simular_parcelamento(SimulacaoParcelamentoInput(
            renda_mensal=D(renda), total_despesas_atuais=D(desp), valor_compra=D(compra),
            taxa_juros_mensal_percentual=D(taxa), max_parcelas=mx))

    # dízima: 100,00 em 3x
    assert parcelas_detalhadas(D("100.00"), D("0"), 3) == [D("33.33"), D("33.33"), D("33.34")]
    assert parcelas_detalhadas(D("200.00"), D("0"), 3) == [D("66.67"), D("66.67"), D("66.66")]
    for n in range(2, 49):                       # soma sempre fecha na compra, sem juros
        assert sum(parcelas_detalhadas(D("1234.56"), D("0"), n)) == D("1234.56")

    r = sim("5000", "3000", "1200", mx=6)
    assert r.folga_mensal_atual == D("2000.00") and len(r.opcoes) == 5
    assert r.opcoes[0].numero_parcelas == 2 and r.opcoes[0].valor_parcela == D("600.00")
    assert all(o.custo_juros == 0 and o.valor_total_pago == D("1200.00") for o in r.opcoes)
    assert r.menor_parcelamento_viavel.numero_parcelas == 2 and r.existe_opcao_viavel
    assert r.opcoes[0].novo_percentual_comprometimento == D("72.00")

    # estouro de 1 centavo: folga 33,33; 3x tem última de 33,34 -> inviável; 4x ok
    r = sim("1000", "966.67", "100.00", mx=6)
    assert r.folga_mensal_atual == D("33.33")
    o3 = r.opcoes[1]
    assert o3.numero_parcelas == 3 and o3.valor_parcela == D("33.33")
    assert o3.saldo_mensal_restante == D("-0.01") and not o3.viavel_no_orcamento
    assert r.menor_parcelamento_viavel.numero_parcelas == 4
    assert r.menor_parcelamento_viavel.valor_parcela == D("25.00")

    # nenhuma opção viável
    r = sim("1000", "990", "1000", mx=4)
    assert not r.existe_opcao_viavel and r.menor_parcelamento_viavel is None

    # Tabela Price: 1000 a 1% a.m. em 12x -> PMT 88,8488 -> 88,85; total 1066,19
    r = sim("5000", "0", "1000", taxa="1", mx=12)
    o12 = r.opcoes[-1]
    assert o12.numero_parcelas == 12 and o12.valor_parcela == D("88.85")
    assert o12.valor_total_pago == D("1066.19") and o12.custo_juros == D("66.19")
    ps = parcelas_detalhadas(D("1000"), D("1"), 12)
    assert ps[-1] == D("88.84") and sum(ps) == D("1066.19")
    assert all(o.custo_juros > 0 for o in r.opcoes)
    assert r.opcoes[0].custo_juros < r.opcoes[-1].custo_juros       # mais parcelas -> mais juros

    # folga negativa
    r = sim("1000", "1500", "100")
    assert r.folga_mensal_atual == D("-500.00") and not r.existe_opcao_viavel
    print("simulador_parcelamento OK")
