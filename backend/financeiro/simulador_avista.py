"""Simulação de compra à vista no mês corrente."""

from decimal import Decimal

from .schemas import SimulacaoAvistaInput, SimulacaoAvistaOutput
from .utils import ZERO, arredondar_moeda, percentual


def simular_avista(entrada: SimulacaoAvistaInput) -> SimulacaoAvistaOutput:
    antes = arredondar_moeda(entrada.renda_mensal - entrada.total_despesas_atuais)
    pos = arredondar_moeda(antes - entrada.valor_compra)
    novas_despesas = entrada.total_despesas_atuais + entrada.valor_compra
    return SimulacaoAvistaOutput(
        saldo_antes_compra=antes,
        saldo_pos_compra=pos,
        deficit_gerado=max(-pos, ZERO),
        percentual_comprometimento_atual=percentual(entrada.total_despesas_atuais, entrada.renda_mensal),
        percentual_comprometimento_pos_compra=percentual(novas_despesas, entrada.renda_mensal),
        cabe_no_orcamento=pos >= 0,
    )


if __name__ == "__main__":
    D = Decimal

    def s(renda, desp, compra):
        return simular_avista(SimulacaoAvistaInput(
            renda_mensal=D(renda), total_despesas_atuais=D(desp), valor_compra=D(compra)))

    r = s("5000", "3000", "1000")
    assert r.saldo_antes_compra == D("2000.00") and r.saldo_pos_compra == D("1000.00")
    assert r.deficit_gerado == D("0.00") and r.cabe_no_orcamento
    assert r.percentual_comprometimento_atual == D("60.00")
    assert r.percentual_comprometimento_pos_compra == D("80.00")

    r = s("5000", "3000", "2000")             # zera exatamente: cabe
    assert r.saldo_pos_compra == D("0.00") and r.cabe_no_orcamento and r.deficit_gerado == D("0.00")
    r = s("5000", "3000", "2000.01")          # estouro de 1 centavo
    assert not r.cabe_no_orcamento and r.deficit_gerado == D("0.01")
    assert r.saldo_pos_compra == D("-0.01")
    assert r.percentual_comprometimento_pos_compra == D("100.00")   # 100.0002 -> 100.00

    r = s("3000", "3500", "100")              # já no vermelho
    assert r.saldo_antes_compra == D("-500.00") and r.deficit_gerado == D("600.00")
    assert r.percentual_comprometimento_atual == D("116.67")
    r = s("1234.56", "0", "1234.56")
    assert r.cabe_no_orcamento and r.percentual_comprometimento_pos_compra == D("100.00")
    print("simulador_avista OK")
