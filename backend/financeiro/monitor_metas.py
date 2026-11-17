"""Monitor de metas por categoria: consumo, severidade e alerta push."""

from decimal import Decimal

from .schemas import MonitorMetaInput, MonitorMetaOutput, NivelSeveridade
from .utils import ZERO, arredondar_moeda, percentual

_ORDEM = {NivelSeveridade.NORMAL: 0, NivelSeveridade.ALERTA: 1, NivelSeveridade.CRITICO: 2}


def classificar_severidade(gasto: Decimal, limite: Decimal) -> NivelSeveridade:
    """Comparação exata em Decimal (sem usar o percentual arredondado):
    NORMAL < 80% | ALERTA 80%..100% (inclusive) | CRITICO > 100%."""
    if gasto > limite:
        return NivelSeveridade.CRITICO
    if gasto * 100 >= limite * 80:
        return NivelSeveridade.ALERTA
    return NivelSeveridade.NORMAL


def monitorar_meta(entrada: MonitorMetaInput) -> MonitorMetaOutput:
    """`disparar_alerta_push` é True só quando a nova transação (> 0) faz a
    categoria SUBIR de nível (NORMAL->ALERTA, NORMAL->CRITICO ou
    ALERTA->CRITICO), evitando notificação repetida a cada gasto."""
    limite = entrada.limite_meta
    anterior = entrada.gasto_acumulado_anterior
    atual = arredondar_moeda(anterior + entrada.nova_transacao)

    sev_antes = classificar_severidade(anterior, limite)
    sev_agora = classificar_severidade(atual, limite)
    push = entrada.nova_transacao > 0 and _ORDEM[sev_agora] > _ORDEM[sev_antes]

    return MonitorMetaOutput(
        categoria=entrada.categoria,
        limite_meta=limite,
        gasto_acumulado_atual=atual,
        saldo_restante=max(limite - atual, ZERO),
        valor_estouro=max(atual - limite, ZERO),
        percentual_consumido=percentual(atual, limite),
        severidade=sev_agora,
        disparar_alerta_push=push,
    )


if __name__ == "__main__":
    D = Decimal
    S = NivelSeveridade

    def m(limite, ant, nova="0"):
        return monitorar_meta(MonitorMetaInput(
            categoria="Lazer", limite_meta=D(limite), gasto_acumulado_anterior=D(ant),
            nova_transacao=D(nova)))

    r = m("1000", "500")
    assert r.severidade == S.NORMAL and r.percentual_consumido == D("50.00")
    assert r.saldo_restante == D("500.00") and r.valor_estouro == D("0.00") and not r.disparar_alerta_push

    assert m("1000", "799.99").severidade == S.NORMAL                  # 1 centavo antes
    r = m("1000", "799.99", "0.01")
    assert r.severidade == S.ALERTA and r.disparar_alerta_push        # cruzou 80% exato
    assert m("1000", "1000").severidade == S.ALERTA                    # 100% exato ainda é ALERTA
    r = m("1000", "1000", "0.01")
    assert r.severidade == S.CRITICO and r.valor_estouro == D("0.01") and r.saldo_restante == D("0.00")
    assert r.percentual_consumido == D("100.00") and r.disparar_alerta_push  # 100.001% -> arredonda 100.00, mas CRITICO
    r = m("1000", "900", "50")
    assert r.severidade == S.ALERTA and not r.disparar_alerta_push     # já estava em ALERTA
    r = m("1000", "900", "200")
    assert r.severidade == S.CRITICO and r.disparar_alerta_push
    assert r.valor_estouro == D("100.00") and r.percentual_consumido == D("110.00")
    r = m("1000", "1100", "10")
    assert r.severidade == S.CRITICO and not r.disparar_alerta_push    # já crítico
    r = m("300", "100")
    assert r.percentual_consumido == D("33.33")                        # dízima
    assert not m("1000", "900").disparar_alerta_push                   # sem nova transação
    print("monitor_metas OK")
