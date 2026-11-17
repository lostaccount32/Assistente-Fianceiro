"""Helpers numéricos e de data compartilhados. Python puro, sem float."""

import calendar
import re
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from .schemas import Periodicidade

CENTAVO = Decimal("0.01")
ZERO = Decimal("0.00")
CEM = Decimal("100")

FormatoMoeda = Literal["auto", "br", "us"]


# ---------------------------------------------------------------------
# Arredondamento
# ---------------------------------------------------------------------

def para_decimal(valor: "Decimal | int | str") -> Decimal:
    """Converte para Decimal rejeitando float (evita imprecisão binária)."""
    if isinstance(valor, float):
        raise TypeError("float não é permitido em cálculos monetários; use Decimal ou str")
    return valor if isinstance(valor, Decimal) else Decimal(valor)


def arredondar(valor: Decimal, casas: int = 2) -> Decimal:
    """Arredonda com ROUND_HALF_UP para `casas` casas decimais."""
    return para_decimal(valor).quantize(Decimal(1).scaleb(-casas), rounding=ROUND_HALF_UP)


def arredondar_moeda(valor: Decimal) -> Decimal:
    return arredondar(valor, 2)


def arredondar_percentual(valor: Decimal) -> Decimal:
    return arredondar(valor, 2)


def percentual(parte: Decimal, total: Decimal) -> Decimal:
    """(parte / total) * 100 arredondado a 2 casas. Total zero -> 0.00."""
    if total == 0:
        return ZERO
    return arredondar_percentual(parte * CEM / total)


def para_centavos(valor: Decimal) -> int:
    """Decimal monetário -> inteiro de centavos (exato)."""
    return int(arredondar_moeda(valor) * 100)


def de_centavos(centavos: int) -> Decimal:
    return (Decimal(centavos) / 100).quantize(CENTAVO)


# ---------------------------------------------------------------------
# Parser de moeda
# ---------------------------------------------------------------------

def parse_moeda(texto: "str | Decimal | int", formato: FormatoMoeda = "auto") -> Decimal:
    """Converte texto monetário BRL/US em Decimal (2 casas, ROUND_HALF_UP).

    Aceita "R$ 1.234,56", "1.234,56", "1,234.56", "1234.56", "1234,56",
    "-R$ 10,00", "(10,00)", "US$ 5.00".

    `formato`: "br" (vírgula decimal), "us" (ponto decimal) ou "auto".
    No modo auto, quando há apenas UM separador:
      - vírgula  -> decimal ("12,5" = 12.50);
      - ponto seguido de exatamente 3 dígitos e parte inteira de 1-3 dígitos
        diferente de 0 -> milhar BR ("1.234" = 1234.00); caso contrário decimal.
    Levanta ValueError se não for possível interpretar.
    """
    if isinstance(texto, (Decimal, int)) and not isinstance(texto, bool):
        return arredondar_moeda(Decimal(texto))
    if not isinstance(texto, str):
        raise ValueError(f"valor monetário inválido: {texto!r}")

    original = texto
    s = texto.strip()
    negativo = False
    if s.startswith("(") and s.endswith(")"):
        negativo, s = True, s[1:-1]
    s = re.sub(r"(?i)US\$|R\$|\$|\s", "", s.replace(" ", ""))
    if s.startswith("-"):
        negativo, s = True, s[1:]
    elif s.startswith("+"):
        s = s[1:]
    if not s or not re.fullmatch(r"[\d.,]+", s):
        raise ValueError(f"valor monetário inválido: {original!r}")

    tem_ponto, tem_virgula = "." in s, "," in s
    if tem_ponto and tem_virgula:
        decimal_sep = "," if s.rfind(",") > s.rfind(".") else "."
        if s.count(decimal_sep) != 1:
            raise ValueError(f"valor monetário inválido: {original!r}")
    elif tem_ponto or tem_virgula:
        sep = "." if tem_ponto else ","
        if s.count(sep) > 1:
            decimal_sep = None  # só pode ser separador de milhar
        elif formato == "br":
            decimal_sep = "," if sep == "," else None
        elif formato == "us":
            decimal_sep = "." if sep == "." else None
        elif sep == ",":
            decimal_sep = ","
        else:
            inteiro, frac = s.split(".")
            milhar = len(frac) == 3 and 1 <= len(inteiro) <= 3 and inteiro != "0"
            decimal_sep = None if milhar else "."
    else:
        decimal_sep = None

    milhar_sep = None
    if tem_ponto and tem_virgula:
        milhar_sep = "." if decimal_sep == "," else ","
    elif decimal_sep is None and (tem_ponto or tem_virgula):
        milhar_sep = "." if tem_ponto else ","

    if decimal_sep:
        parte_int, parte_frac = s.split(decimal_sep)
    else:
        parte_int, parte_frac = s, ""
    if milhar_sep:
        if not re.fullmatch(r"\d{1,3}(?:%s\d{3})+" % re.escape(milhar_sep), parte_int):
            raise ValueError(f"valor monetário inválido: {original!r}")
        parte_int = parte_int.replace(milhar_sep, "")
    if (parte_frac and not parte_frac.isdigit()) or not (parte_int or parte_frac):
        raise ValueError(f"valor monetário inválido: {original!r}")

    valor = Decimal(f"{parte_int or '0'}.{parte_frac or '0'}")
    return arredondar_moeda(-valor if negativo else valor)


# ---------------------------------------------------------------------
# Datas
# ---------------------------------------------------------------------

_FORMATOS_DATA = ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%Y/%m/%d")


def parse_data(texto: "str | date | datetime") -> date:
    """Converte texto em date. Formatos: dd/mm/aaaa, aaaa-mm-dd, dd-mm-aaaa,
    dd.mm.aaaa, dd/mm/aa, aaaa/mm/dd. Levanta ValueError se inválida."""
    if isinstance(texto, datetime):
        return texto.date()
    if isinstance(texto, date):
        return texto
    s = str(texto).strip()
    for fmt in _FORMATOS_DATA:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"data inválida: {texto!r}")


def dias_no_mes(ref: date) -> int:
    return calendar.monthrange(ref.year, ref.month)[1]


def dias_no_ano(ref: date) -> int:
    return 366 if calendar.isleap(ref.year) else 365


def dias_totais_ciclo(periodicidade: Periodicidade, ref: date) -> int:
    """Duração (dias) do ciclo corrente que contém `ref`.

    semanal = semana seg-dom; quinzenal = dias 1-15 ou 16-fim do mês;
    mensal = mês civil; anual = ano civil.
    """
    if periodicidade == Periodicidade.DIARIA:
        return 1
    if periodicidade == Periodicidade.SEMANAL:
        return 7
    if periodicidade == Periodicidade.QUINZENAL:
        return 15 if ref.day <= 15 else dias_no_mes(ref) - 15
    if periodicidade == Periodicidade.MENSAL:
        return dias_no_mes(ref)
    return dias_no_ano(ref)


def dias_restantes_ciclo(periodicidade: Periodicidade, ref: date) -> int:
    """Dias restantes no ciclo, INCLUINDO o dia `ref` (mínimo 1)."""
    if periodicidade == Periodicidade.DIARIA:
        return 1
    if periodicidade == Periodicidade.SEMANAL:
        return 7 - ref.weekday()
    if periodicidade == Periodicidade.QUINZENAL:
        return 16 - ref.day if ref.day <= 15 else dias_no_mes(ref) - ref.day + 1
    if periodicidade == Periodicidade.MENSAL:
        return dias_no_mes(ref) - ref.day + 1
    return dias_no_ano(ref) - ref.timetuple().tm_yday + 1


if __name__ == "__main__":
    # arredondamento
    assert arredondar(Decimal("2.675")) == Decimal("2.68")      # half-up (float daria 2.67)
    assert arredondar(Decimal("0.005")) == Decimal("0.01")
    assert arredondar(Decimal("-0.005")) == Decimal("-0.01")
    assert arredondar(Decimal("1.004")) == Decimal("1.00")
    assert percentual(Decimal("1"), Decimal("3")) == Decimal("33.33")
    assert percentual(Decimal("2"), Decimal("3")) == Decimal("66.67")
    assert percentual(Decimal("5"), Decimal("0")) == Decimal("0.00")
    assert para_centavos(Decimal("10.05")) == 1005 and de_centavos(1005) == Decimal("10.05")
    try:
        para_decimal(1.1)
        raise SystemExit("float deveria falhar")
    except TypeError:
        pass

    # moeda BRL/US
    assert parse_moeda("R$ 1.234,56") == Decimal("1234.56")
    assert parse_moeda("R$1.234.567,89") == Decimal("1234567.89")
    assert parse_moeda("1234,56") == Decimal("1234.56")
    assert parse_moeda("1,234.56") == Decimal("1234.56")
    assert parse_moeda("1234.56") == Decimal("1234.56")
    assert parse_moeda("US$ 5.5") == Decimal("5.50")
    assert parse_moeda("-R$ 10,00") == Decimal("-10.00")
    assert parse_moeda("(10,00)") == Decimal("-10.00")
    assert parse_moeda("12,5") == Decimal("12.50")
    assert parse_moeda("1.234") == Decimal("1234.00")            # milhar BR
    assert parse_moeda("0.123") == Decimal("0.12")
    assert parse_moeda("1.234", formato="us") == Decimal("1.23")
    assert parse_moeda("1,234", formato="us") == Decimal("1234.00")
    assert parse_moeda("10,005") == Decimal("10.01")             # half-up
    assert parse_moeda("1.234.567") == Decimal("1234567.00")
    assert parse_moeda(",50") == Decimal("0.50")
    for ruim in ("", "abc", "R$", "1,2,3", "12.34,56,78", "1.23.456", "10 reais"):
        try:
            parse_moeda(ruim)
            raise SystemExit(f"deveria falhar: {ruim!r}")
        except ValueError:
            pass

    # datas
    assert parse_data("15/03/2026") == date(2026, 3, 15)
    assert parse_data("2026-03-15") == date(2026, 3, 15)
    assert parse_data("15-03-2026") == date(2026, 3, 15)
    assert parse_data("15/03/26") == date(2026, 3, 15)
    for ruim in ("31/02/2026", "xx", ""):
        try:
            parse_data(ruim)
            raise SystemExit(f"deveria falhar: {ruim!r}")
        except ValueError:
            pass

    # ciclos
    fev_bissexto = date(2024, 2, 10)
    assert dias_totais_ciclo(Periodicidade.MENSAL, fev_bissexto) == 29
    assert dias_restantes_ciclo(Periodicidade.MENSAL, fev_bissexto) == 20
    assert dias_totais_ciclo(Periodicidade.ANUAL, fev_bissexto) == 366
    assert dias_restantes_ciclo(Periodicidade.ANUAL, date(2026, 12, 31)) == 1
    assert dias_restantes_ciclo(Periodicidade.ANUAL, date(2026, 1, 1)) == 365
    assert dias_restantes_ciclo(Periodicidade.MENSAL, date(2026, 1, 31)) == 1
    assert dias_totais_ciclo(Periodicidade.QUINZENAL, date(2026, 1, 20)) == 16
    assert dias_restantes_ciclo(Periodicidade.QUINZENAL, date(2026, 1, 20)) == 12
    assert dias_restantes_ciclo(Periodicidade.QUINZENAL, date(2026, 1, 15)) == 1
    assert dias_restantes_ciclo(Periodicidade.SEMANAL, date(2026, 11, 16)) == 7   # segunda
    assert dias_restantes_ciclo(Periodicidade.SEMANAL, date(2026, 11, 22)) == 1   # domingo
    print("utils OK")
