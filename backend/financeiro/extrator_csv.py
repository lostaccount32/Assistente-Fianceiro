"""Extração e higienização de CSV de compras."""

import csv
import io
import unicodedata
from decimal import Decimal
from pathlib import Path

from .schemas import ErroLinhaCsv, ExtracaoCsvOutput, Pilar503020, TransacaoValidada
from .utils import ZERO, arredondar_moeda, parse_data, parse_moeda

_ALIASES: dict[str, tuple[str, ...]] = {
    "data": ("data", "date", "dt", "data_compra", "data_da_compra"),
    "estabelecimento": ("estabelecimento", "descricao", "loja", "merchant", "local", "historico", "nome"),
    "valor": ("valor", "amount", "value", "preco", "total", "valor_r$", "valor_rs"),
    "categoria": ("categoria", "category", "grupo"),
    "pilar": ("pilar", "tipo"),
}
_OBRIGATORIAS = ("data", "estabelecimento", "valor")
_PILARES = {
    "necessidades": Pilar503020.NECESSIDADES, "necessidade": Pilar503020.NECESSIDADES,
    "desejos": Pilar503020.DESEJOS, "desejo": Pilar503020.DESEJOS,
    "poupanca": Pilar503020.POUPANCA_DIVIDAS, "poupanca_dividas": Pilar503020.POUPANCA_DIVIDAS,
    "dividas": Pilar503020.POUPANCA_DIVIDAS,
}


def _norm(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return sem_acento.strip().lower().replace(" ", "_")


def _detectar_delimitador(cabecalho: str) -> str:
    candidatos = (";", ",", "\t", "|")
    return max(candidatos, key=cabecalho.count) if any(c in cabecalho for c in candidatos) else ","


def extrair_csv_texto(conteudo: str) -> ExtracaoCsvOutput:
    """Lê CSV (delimitador `;` `,` tab ou `|` detectado no cabeçalho) com as
    colunas data, estabelecimento, valor [, categoria, pilar] (aliases e
    acentos aceitos). Linhas em branco são ignoradas silenciosamente; linhas
    inválidas vão para `erros` (número da linha física do arquivo) e nunca
    interrompem o processamento. Valor deve ser > 0; pilar ausente = desejos,
    categoria ausente = "Outros"."""
    conteudo = conteudo.lstrip("﻿")
    linhas = conteudo.splitlines()
    primeira = next((l for l in linhas if l.strip()), "")
    delim = _detectar_delimitador(primeira)

    reader = csv.reader(io.StringIO(conteudo, newline=""), delimiter=delim)
    transacoes: list[TransacaoValidada] = []
    erros: list[ErroLinhaCsv] = []
    colunas: dict[str, int] | None = None

    for row in reader:
        numero = reader.line_num
        if not any(c.strip() for c in row):
            continue
        bruto = delim.join(row)

        if colunas is None:  # primeira linha não vazia = cabeçalho
            nomes = [_norm(c) for c in row]
            colunas = {}
            for campo, aliases in _ALIASES.items():
                for i, n in enumerate(nomes):
                    if n in aliases:
                        colunas[campo] = i
                        break
            ausentes = [c for c in _OBRIGATORIAS if c not in colunas]
            if ausentes:
                erros.append(ErroLinhaCsv(
                    linha=numero, conteudo_bruto=bruto,
                    motivo=f"cabeçalho inválido: colunas obrigatórias ausentes: {', '.join(ausentes)}"))
                return _saida(transacoes, erros, ignoradas=0)
            continue

        def campo(nome: str) -> str:
            i = colunas.get(nome)
            return row[i].strip() if i is not None and i < len(row) else ""

        try:
            if len(row) < max(colunas.values()) + 1 and not all(campo(c) for c in _OBRIGATORIAS):
                raise ValueError("linha com colunas faltando")
            estab = campo("estabelecimento")
            if not estab:
                raise ValueError("estabelecimento vazio")
            try:
                data = parse_data(campo("data"))
            except ValueError:
                raise ValueError(f"data inválida: {campo('data')!r}") from None
            try:
                valor = parse_moeda(campo("valor"))
            except ValueError:
                raise ValueError(f"valor inválido: {campo('valor')!r}") from None
            if valor <= 0:
                raise ValueError(f"valor deve ser positivo: {campo('valor')!r}")
            pilar_txt = _norm(campo("pilar"))
            if pilar_txt and pilar_txt not in _PILARES:
                raise ValueError(f"pilar inválido: {campo('pilar')!r}")
            transacoes.append(TransacaoValidada(
                data=data, estabelecimento=" ".join(estab.split()), valor=valor,
                categoria=" ".join(campo("categoria").split()) or "Outros",
                pilar=_PILARES[pilar_txt] if pilar_txt else Pilar503020.DESEJOS,
            ))
        except ValueError as e:
            erros.append(ErroLinhaCsv(linha=numero, conteudo_bruto=bruto, motivo=str(e)))

    if colunas is None:
        erros.append(ErroLinhaCsv(linha=1, conteudo_bruto="", motivo="arquivo vazio"))
        return _saida(transacoes, erros, ignoradas=0)
    return _saida(transacoes, erros, ignoradas=len(erros))


def _saida(transacoes: list[TransacaoValidada], erros: list[ErroLinhaCsv], ignoradas: int) -> ExtracaoCsvOutput:
    return ExtracaoCsvOutput(
        transacoes=transacoes,
        erros=erros,
        total_validado=arredondar_moeda(sum((t.valor for t in transacoes), ZERO)),
        quantidade_validas=len(transacoes),
        quantidade_ignoradas=ignoradas,
    )


def extrair_csv_arquivo(caminho: "str | Path", encoding: str | None = None) -> ExtracaoCsvOutput:
    """Lê o arquivo (UTF-8 com/sem BOM; fallback latin-1 se encoding não informado)."""
    bruto = Path(caminho).read_bytes()
    if encoding:
        return extrair_csv_texto(bruto.decode(encoding))
    try:
        return extrair_csv_texto(bruto.decode("utf-8-sig"))
    except UnicodeDecodeError:
        return extrair_csv_texto(bruto.decode("latin-1"))


if __name__ == "__main__":
    import tempfile
    from datetime import date

    D = Decimal
    csv_br = (
        "Data;Estabelecimento;Valor;Categoria;Pilar\n"
        "15/03/2026;Mercado Central;R$ 1.234,56;Alimentação;necessidades\n"
        "16/03/2026;  Cinema   Plaza ;45,90;Lazer;\n"
        "\n"
        "2026-03-17;Posto;R$ 200,00;;\n"
        "31/02/2026;Data ruim;10,00;;\n"
        "18/03/2026;Valor ruim;abc;;\n"
        "19/03/2026;;10,00;;\n"
        "20/03/2026;Negativo;-5,00;;\n"
        "21/03/2026;Pilar ruim;5,00;Lazer;xyz\n"
        "22/03/2026\n"
    )
    r = extrair_csv_texto(csv_br)
    assert r.quantidade_validas == 3 and r.quantidade_ignoradas == 6
    assert r.total_validado == D("1480.46")                       # 1234,56 + 45,90 + 200,00
    t0, t1, t2 = r.transacoes
    assert t0.data == date(2026, 3, 15) and t0.valor == D("1234.56") and t0.pilar == Pilar503020.NECESSIDADES
    assert t1.estabelecimento == "Cinema Plaza" and t1.pilar == Pilar503020.DESEJOS
    assert t2.categoria == "Outros" and t2.data == date(2026, 3, 17)
    assert [e.linha for e in r.erros] == [6, 7, 8, 9, 10, 11]
    assert "data inválida" in r.erros[0].motivo and "valor inválido" in r.erros[1].motivo
    assert "estabelecimento" in r.erros[2].motivo and "positivo" in r.erros[3].motivo
    assert "pilar" in r.erros[4].motivo and r.erros[0].conteudo_bruto == "31/02/2026;Data ruim;10,00;;"

    # CSV com vírgula, valor BRL entre aspas, BOM, cabeçalho em inglês e colunas em outra ordem
    csv_us = '﻿amount,date,merchant\n"R$ 1.234,56",2026-01-05,Loja A\n0.10,2026-01-06,Loja B\n0.20,2026-01-07,Loja C\n'
    r = extrair_csv_texto(csv_us)
    assert r.quantidade_validas == 3 and r.total_validado == D("1234.86")   # 0.1+0.2 exato (sem float)
    assert r.transacoes[0].valor == D("1234.56")

    # cabeçalho sem colunas obrigatórias / arquivo vazio
    r = extrair_csv_texto("foo;bar\n1;2\n")
    assert r.quantidade_validas == 0 and r.erros[0].linha == 1 and "obrigatórias" in r.erros[0].motivo
    assert extrair_csv_texto("").erros[0].motivo == "arquivo vazio"
    assert extrair_csv_texto("data;estabelecimento;valor\n").quantidade_validas == 0

    # arredondamento half-up no valor
    r = extrair_csv_texto("data;estabelecimento;valor\n01/01/2026;X;10,005\n")
    assert r.transacoes[0].valor == D("10.01")

    # arquivo em latin-1
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "c.csv"
        p.write_bytes("data;estabelecimento;valor\n01/01/2026;Padaria Ação;3,50\n".encode("latin-1"))
        r = extrair_csv_arquivo(p)
        assert r.transacoes[0].estabelecimento == "Padaria Ação"
    print("extrator_csv OK")
