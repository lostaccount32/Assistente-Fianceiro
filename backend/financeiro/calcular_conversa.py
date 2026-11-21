import importlib
import importlib.machinery
import importlib.util
import inspect
import json
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent.parent
for p in (str(BASE_DIR), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)


def to_dec(val: Any) -> Decimal:
    return Decimal(str(val)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def fmt_brl(val: Decimal) -> str:
    s = f"{val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"


def _try_import_module(module_name: str, errors: Dict[str, str]) -> Optional[Any]:
    if "backend" not in sys.modules:
        pkg_backend = importlib.util.module_from_spec(
            importlib.machinery.ModuleSpec("backend", loader=None, is_package=True)
        )
        pkg_backend.__path__ = [str(REPO_ROOT / "backend")]
        sys.modules["backend"] = pkg_backend

    pkg_full_name = f"backend.financeiro.{module_name}"
    if "backend.financeiro" not in sys.modules:
        pkg_fin = importlib.util.module_from_spec(
            importlib.machinery.ModuleSpec("backend.financeiro", loader=None, is_package=True)
        )
        pkg_fin.__path__ = [str(BASE_DIR)]
        sys.modules["backend.financeiro"] = pkg_fin

    file_path = BASE_DIR / f"{module_name}.py"
    if not file_path.exists():
        errors[module_name] = f"Arquivo não encontrado: {file_path}"
        return None

    try:
        spec = importlib.util.spec_from_file_location(pkg_full_name, str(file_path))
        if spec is None or spec.loader is None:
            errors[module_name] = "Não foi possível criar spec de importação."
            return None
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = "backend.financeiro"
        sys.modules[pkg_full_name] = mod
        spec.loader.exec_module(mod)
        return mod
    except Exception as exc:
        errors[module_name] = str(exc)
        return None


def _find_callable(mod: Any, candidates: List[str]) -> Optional[Callable[..., Any]]:
    if mod is None:
        return None
    for name in candidates:
        fn = getattr(mod, name, None)
        if callable(fn):
            return fn
    return None

def _build_schema_instance(schema_cls: Any, payload: Dict[str, Any]) -> Optional[Any]:
    try:
        sig = inspect.signature(schema_cls)
        kwargs: Dict[str, Any] = {}
        for name, param in sig.parameters.items():
            lname = name.lower()
            if "renda" in lname or "receita" in lname:
                kwargs[name] = payload.get("renda")
            elif "despesa" in lname or "gasto_mensal" in lname or "fixo" in lname:
                kwargs[name] = payload.get("total_despesas")
            elif "variavel" in lname or "variável" in lname:
                kwargs[name] = payload.get("total_variaveis")
            elif "saldo" in lname:
                kwargs[name] = payload.get("saldo_livre")
            elif "valor" in lname or "compra" in lname or "gasto" in lname or "preco" in lname:
                kwargs[name] = payload.get("valor_gasto")
            elif "parcela" in lname and ("qtd" in lname or "num" in lname or "mes" in lname or "n" in lname):
                kwargs[name] = payload.get("parcelas")
            elif "juro" in lname or "taxa" in lname:
                kwargs[name] = payload.get("taxa_juros_mensal", Decimal("0.00"))
            elif param.default is inspect.Parameter.empty:
                kwargs[name] = Decimal("0.00")
        return schema_cls(**kwargs)
    except Exception:
        return None

def _call_with_adapted_args(fn: Callable[..., Any], payload: Dict[str, Any]) -> Any:
    sig = inspect.signature(fn)
    params = sig.parameters

    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return fn(**payload)

    positional_params = [
        p
        for p in params.values()
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]

    if len(positional_params) == 1:
        p = positional_params[0]
        p_name = p.name.lower()
        if any(k in p_name for k in ("dados", "payload", "entrada", "params", "config", "perfil", "data")):
            ann = p.annotation
            if ann is not inspect.Parameter.empty and ann not in (dict, Dict, Any):
                inst = _build_schema_instance(ann, payload)
                if inst is not None:
                    return fn(inst)
            return fn(payload)

    kw: Dict[str, Any] = {}
    for name, param in params.items():
        lname = name.lower()
        if "renda" in lname or "receita" in lname:
            kw[name] = payload.get("renda")
        elif "despesa" in lname or "fixo" in lname or "gasto_mensal" in lname:
            kw[name] = payload.get("total_despesas")
        elif "saldo" in lname:
            kw[name] = payload.get("saldo_livre")
        elif "valor" in lname or "compra" in lname or "gasto" in lname or "preco" in lname:
            kw[name] = payload.get("valor_gasto")
        elif "parcela" in lname and ("qtd" in lname or "num" in lname or "mes" in lname or "n" in lname):
            kw[name] = payload.get("parcelas")
        elif "juro" in lname or "taxa" in lname:
            kw[name] = payload.get("taxa_juros_mensal", Decimal("0.00"))
        elif param.default is inspect.Parameter.empty:
            kw[name] = None

    return fn(**kw)


def _serialize_result(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {str(k): _serialize_result(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialize_result(x) for x in obj]
    if hasattr(obj, "model_dump"):
        return _serialize_result(obj.model_dump())
    if hasattr(obj, "__dict__"):
        return _serialize_result(vars(obj))
    return obj


def rodar_modulos_financeiros(
    renda: Decimal,
    total_fixos: Decimal,
    total_variaveis: Decimal,
    total_despesas: Decimal,
    saldo_livre: Decimal,
    valor_gasto: Optional[Decimal] = None,
    parcelas: Optional[int] = None,
    taxa_juros_mensal: Decimal = Decimal("0.00"),
) -> Dict[str, Any]:
    erros_importacao: Dict[str, str] = {}
    mod_balanco = _try_import_module("balanco_orcamentario", erros_importacao)
    mod_avista = _try_import_module("simulador_avista", erros_importacao)
    mod_parcela = _try_import_module("simulador_parcelamento", erros_importacao)
    mod_50_30_20 = _try_import_module("analisador_50_30_20", erros_importacao)

    base_ctx: Dict[str, Any] = {
        "renda": renda,
        "total_fixos": total_fixos,
        "total_variaveis": total_variaveis,
        "total_despesas": total_despesas,
        "saldo_livre": saldo_livre,
        "valor_gasto": valor_gasto,
        "parcelas": parcelas,
        "taxa_juros_mensal": taxa_juros_mensal,
    }

    resultados: Dict[str, Any] = {
        "modulos_carregados": {
            "balanco_orcamentario": mod_balanco is not None,
            "simulador_avista": mod_avista is not None,
            "simulador_parcelamento": mod_parcela is not None,
            "analisador_50_30_20": mod_50_30_20 is not None,
        },
        "erros_importacao": erros_importacao,
        "balanco": None,
        "simulacao_avista": None,
        "simulacao_parcelamento": None,
    }

    fn_balanco = _find_callable(
        mod_balanco,
        ["calcular_balanco", "gerar_balanco", "balanco_orcamentario", "executar", "calcular"],
    )
    if fn_balanco:
        try:
            resultados["balanco"] = _serialize_result(_call_with_adapted_args(fn_balanco, base_ctx))
        except Exception as exc:
            resultados["balanco"] = {"erro_execucao": str(exc)}

    if valor_gasto is not None:
        fn_avista = _find_callable(
            mod_avista,
            ["simular_avista", "simular_compra_avista", "simulador_avista", "executar", "simular"],
        )
        if fn_avista:
            try:
                resultados["simulacao_avista"] = _serialize_result(
                    _call_with_adapted_args(fn_avista, base_ctx)
                )
            except Exception as exc:
                resultados["simulacao_avista"] = {"erro_execucao": str(exc)}

    if valor_gasto is not None and parcelas is not None and parcelas >= 2:
        fn_parcela = _find_callable(
            mod_parcela,
            ["simular_parcelamento", "simular_parcelas", "simulador_parcelamento", "executar", "simular"],
        )
        if fn_parcela:
            try:
                resultados["simulacao_parcelamento"] = _serialize_result(
                    _call_with_adapted_args(fn_parcela, base_ctx)
                )
            except Exception as exc:
                resultados["simulacao_parcelamento"] = {"erro_execucao": str(exc)}

    return resultados


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}

    renda = to_dec(payload.get("renda", 0))
    fixos_itens = [to_dec(x) for x in payload.get("fixos", [])]
    variaveis_itens = [to_dec(x) for x in payload.get("variaveis", [])]

    total_fixos = sum(fixos_itens, Decimal("0.00")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    total_variaveis = sum(variaveis_itens, Decimal("0.00")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    total_despesas = (total_fixos + total_variaveis).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    saldo_livre = (renda - total_despesas).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    pct_comprometido = (
        ((total_despesas / renda) * Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if renda > Decimal("0.00")
        else Decimal("0.00")
    )

    valor_gasto_raw = payload.get("valor_gasto")
    valor_gasto = to_dec(valor_gasto_raw) if valor_gasto_raw is not None else None
    parcelas_raw = payload.get("parcelas")
    parcelas = int(parcelas_raw) if parcelas_raw is not None else None
    taxa_juros = to_dec(payload.get("taxa_juros_mensal", 0))

    modulos_out = rodar_modulos_financeiros(
        renda=renda,
        total_fixos=total_fixos,
        total_variaveis=total_variaveis,
        total_despesas=total_despesas,
        saldo_livre=saldo_livre,
        valor_gasto=valor_gasto,
        parcelas=parcelas,
        taxa_juros_mensal=taxa_juros,
    )

    out: Dict[str, Any] = {
        "renda": float(renda),
        "renda_formatada": fmt_brl(renda),
        "fixos_itens": [float(x) for x in fixos_itens],
        "fixos_formatados": [fmt_brl(x) for x in fixos_itens],
        "total_fixos": float(total_fixos),
        "total_fixos_formatado": fmt_brl(total_fixos),
        "variaveis_itens": [float(x) for x in variaveis_itens],
        "variaveis_formatados": [fmt_brl(x) for x in variaveis_itens],
        "total_variaveis": float(total_variaveis),
        "total_variaveis_formatado": fmt_brl(total_variaveis),
        "total_despesas": float(total_despesas),
        "total_despesas_formatado": fmt_brl(total_despesas),
        "saldo_livre": float(saldo_livre),
        "saldo_livre_formatado": fmt_brl(saldo_livre),
        "percentual_comprometido": f"{pct_comprometido}%",
        "modulos_financeiros": modulos_out,
    }

    if valor_gasto is not None:
        saldo_apos_gasto = (saldo_livre - valor_gasto).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        pct_com_gasto = (
            (((total_despesas + valor_gasto) / renda) * Decimal("100")).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP
            )
            if renda > Decimal("0.00")
            else Decimal("0.00")
        )
        out["avaliacao_gasto"] = {
            "valor_gasto": float(valor_gasto),
            "valor_gasto_formatado": fmt_brl(valor_gasto),
            "saldo_apos_gasto": float(saldo_apos_gasto),
            "saldo_apos_gasto_formatado": fmt_brl(saldo_apos_gasto),
            "percentual_comprometido_com_gasto": f"{pct_com_gasto}%",
        }

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()