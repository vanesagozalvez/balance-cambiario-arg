import rawSectores from "@/data/balance_cambiario_sectores.json";
import rawCore from "@/data/balance_cambiario.json";
import { DatasetBalanceCambiario, DatasetPorSector, SectorMeta, SerieMeta } from "@/types";
import { DETALLE_META } from "@/lib/detalleSeries";

const datasetCore = rawCore as unknown as DatasetBalanceCambiario;

/**
 * Este módulo importa `balance_cambiario_sectores.json` (varios MB: el
 * detalle mensual de cada uno de los ~29 sectores, en 4 niveles: Cuenta,
 * Subcuenta, Grupo y Concepto/movimiento). A propósito es un archivo
 * SEPARADO del dataset principal (`balance_cambiario.json`, ~230 KB): solo
 * la solapa "Comparar por Sector" importa este módulo, así que Next.js lo
 * deja en su propio chunk y el Dashboard / Comparador general no pagan ese
 * peso.
 */
const dataset = rawSectores as unknown as DatasetPorSector;

export function listaSectores(): SectorMeta[] {
  return Object.entries(dataset.porSector ?? {})
    .map(([id, s]) => ({ id, nombre: s.nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

export function nombreSector(sectorId: string): string {
  return dataset.porSector?.[sectorId]?.nombre ?? sectorId;
}

export function getValoresSectorConcepto(sectorId: string, id: string): number[] {
  return dataset.porSector?.[sectorId]?.detalle?.[id] ?? [];
}

/**
 * Resuelve metadatos para CUALQUIER id usado en la solapa "Comparar por
 * Sector": ids de total ("c-…" Cuenta, "sc-…" Subcuenta, "g-…" Grupo) o el
 * id de concepto/movimiento final ("d-…", compartido con el catálogo
 * general). Hace falta este resolutor aparte porque los ids de total no
 * existen en `DETALLE_META` (ese catálogo solo tiene el nivel Concepto).
 */
export function metaDeSector(id: string): SerieMeta {
  const nodo = dataset.nodos?.[id];
  if (nodo) {
    return {
      id,
      nombre: nodo.nombre,
      nombreCorto: nodo.nombre.length > 28 ? `${nodo.nombre.slice(0, 27)}…` : nodo.nombre,
      categoria: nodo.cuenta,
      subcategoria: nodo.subcuenta,
      unidad: "Millones de USD",
      tipo: "detalle",
      descripcion:
        nodo.nivel === "cuenta"
          ? `Total de la Cuenta "${nodo.cuenta}" para el sector seleccionado (suma de todos sus movimientos).`
          : nodo.nivel === "subcuenta"
          ? `Total de "${nodo.cuenta} → ${nodo.subcuenta}" para el sector seleccionado.`
          : `Total de "${nodo.cuenta} → ${nodo.subcuenta} → ${nodo.grupo}" para el sector seleccionado.`,
    };
  }
  if (DETALLE_META[id]) return DETALLE_META[id];
  return {
    id,
    nombre: id,
    nombreCorto: id,
    categoria: "Desconocida",
    unidad: "Millones de USD",
    tipo: "detalle",
    descripcion: "Serie no encontrada.",
  };
}

export interface NodoGrupoSector {
  grupo: string;
  /** Ítem seleccionable con el TOTAL del grupo. Solo existe si el grupo agrupa más de un movimiento. */
  total?: SerieMeta;
  items: SerieMeta[];
}

export interface NodoSubcuentaSector {
  subcuenta: string;
  /** Ítem seleccionable con el TOTAL de la subcuenta (p.ej. "Bienes (total)"). */
  total?: SerieMeta;
  grupos: NodoGrupoSector[];
}

export interface NodoCuentaSector {
  cuenta: string;
  /** Ítem seleccionable con el TOTAL de la cuenta (p.ej. "Cuenta Corriente (total)"). */
  total?: SerieMeta;
  subcuentas: NodoSubcuentaSector[];
}

/**
 * Arma el árbol Cuenta > Subcuenta > Grupo > Concepto para un sector,
 * incluyendo en cada nivel un ítem de TOTAL además de los movimientos hoja
 * — así se puede graficar tanto "Cuenta Corriente" entera como el
 * movimiento puntual "Cobros de exportaciones", para ese sector.
 */
export function arbolSector(sectorId: string): NodoCuentaSector[] {
  const detalleSector = dataset.porSector?.[sectorId]?.detalle ?? {};
  const idsDisponibles = new Set(Object.keys(detalleSector));

  const cuentas = new Map<string, Map<string, Map<string, SerieMeta[]>>>();
  const cuentaTotalId = new Map<string, string>();
  const subcuentaTotalId = new Map<string, string>(); // clave "cuenta|subcuenta"
  const grupoTotalId = new Map<string, string>(); // clave "cuenta|subcuenta|grupo"

  // Paso 1: ubicar, entre los ids que existen para este sector, cuáles son nodos de total.
  for (const id of idsDisponibles) {
    const nodo = dataset.nodos?.[id];
    if (!nodo) continue;
    if (nodo.nivel === "cuenta") cuentaTotalId.set(nodo.cuenta, id);
    else if (nodo.nivel === "subcuenta") subcuentaTotalId.set(`${nodo.cuenta}|${nodo.subcuenta}`, id);
    else if (nodo.nivel === "grupo") grupoTotalId.set(`${nodo.cuenta}|${nodo.subcuenta}|${nodo.grupo}`, id);
  }

  // Paso 2: ubicar los movimientos hoja (Concepto) que existen para este sector y agruparlos.
  for (const [id, meta] of Object.entries(DETALLE_META)) {
    if (!idsDisponibles.has(id)) continue;
    const raw = datasetCore.detalle[id];
    const cuenta = raw?.cuenta ?? meta.categoria;
    const subcuenta = raw?.subcuenta ?? meta.subcategoria ?? "Otros";
    const grupo = raw?.grupo || subcuenta;

    if (!cuentas.has(cuenta)) cuentas.set(cuenta, new Map());
    const subMap = cuentas.get(cuenta)!;
    if (!subMap.has(subcuenta)) subMap.set(subcuenta, new Map());
    const grupoMap = subMap.get(subcuenta)!;
    if (!grupoMap.has(grupo)) grupoMap.set(grupo, []);
    grupoMap.get(grupo)!.push(meta);
  }

  const resultado: NodoCuentaSector[] = [];
  for (const [cuenta, subMap] of cuentas) {
    const subcuentas: NodoSubcuentaSector[] = Array.from(subMap.entries())
      .map(([subcuenta, grupoMap]) => {
        const grupos: NodoGrupoSector[] = Array.from(grupoMap.entries())
          .map(([grupo, items]) => {
            const gid = grupoTotalId.get(`${cuenta}|${subcuenta}|${grupo}`);
            return {
              grupo,
              total: gid ? metaDeSector(gid) : undefined,
              items: items.sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
            };
          })
          .sort((a, b) => a.grupo.localeCompare(b.grupo, "es"));
        const scid = subcuentaTotalId.get(`${cuenta}|${subcuenta}`);
        return { subcuenta, total: scid ? metaDeSector(scid) : undefined, grupos };
      })
      .sort((a, b) => a.subcuenta.localeCompare(b.subcuenta, "es"));
    const cid = cuentaTotalId.get(cuenta);
    resultado.push({ cuenta, total: cid ? metaDeSector(cid) : undefined, subcuentas });
  }

  const ordenCuentas = ["Cuenta Corriente", "Cuenta Capital", "Cuenta Financiera"];
  resultado.sort((a, b) => {
    const ia = ordenCuentas.indexOf(a.cuenta);
    const ib = ordenCuentas.indexOf(b.cuenta);
    if (ia === -1 && ib === -1) return a.cuenta.localeCompare(b.cuenta, "es");
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return resultado;
}
