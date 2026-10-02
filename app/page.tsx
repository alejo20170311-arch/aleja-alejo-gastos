"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./supabaseClient";

type Person = "Alejo" | "Aleja";
type MovementType = "expense" | "loan" | "payment";
type ActiveTab = "home" | "accounts" | "analysis" | "movements";
type SplitMode = "shared" | "alejo" | "aleja";
type Receipt = { name: string; dataUrl: string };
type RemoteWriteResult = { ok: boolean; error?: string };
type Expense = {
  id: string;
  type?: MovementType;
  description: string;
  amount: number;
  category: string;
  paidBy: Person;
  split: SplitMode;
  date: string;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  createdByEmail?: string;
  note: string;
  receipt?: Receipt;
  receiptName?: string;
};
type ExpenseDraft = Omit<
  Expense,
  | "id"
  | "amount"
  | "receipt"
  | "receiptName"
  | "createdBy"
  | "createdByEmail"
> & {
  amount: string;
  receipt?: Receipt;
};

const STORAGE_KEY = "casa-aleja-alejo-expenses";
const SYNC_STORAGE_KEY = "casa-aleja-alejo-pending-sync";
const BATCH_MODE_STORAGE_KEY = "casa-aleja-alejo-batch-loading";
const HOUSEHOLD_ID = "aleja-alejo";
const REMOTE_SYNC_INTERVAL_MS = 3000;
const RECEIPT_MAX_SIZE = 1400;
const RECEIPT_QUALITY = 0.72;
const REMOTE_BATCH_SIZE = 4;
const REMOTE_BATCH_CONCURRENCY = 4;
const LIGHT_MOVEMENT_SELECT = `
  id,
  type:data->>type,
  description:data->>description,
  amount:data->>amount,
  category:data->>category,
  paidBy:data->>paidBy,
  split:data->>split,
  date:data->>date,
  createdAt:data->>createdAt,
  updatedAt:data->>updatedAt,
  createdBy:data->>createdBy,
  createdByEmail:data->>createdByEmail,
  note:data->>note,
  receiptName:data->receipt->>name
`;
let remoteBatchMode = false;
const people: Person[] = ["Alejo", "Aleja"];
const tabs: { id: ActiveTab; label: string }[] = [
  { id: "home", label: "Inicio" },
  { id: "accounts", label: "Cuentas" },
  { id: "analysis", label: "Analisis" },
  { id: "movements", label: "Movimientos" },
];
const categories = [
  "Arriendo",
  "Comida",
  "Servicios",
  "Mercado",
  "Transporte",
  "Salud",
  "Mascotas",
  "Ocio",
  "Otros",
];
const today = new Date().toISOString().slice(0, 10);
const initialDraft: ExpenseDraft = {
  type: "expense",
  description: "",
  amount: "",
  category: "Comida",
  paidBy: "Alejo",
  split: "shared",
  date: today,
  note: "",
};
const currency = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function splitLabel(split: SplitMode) {
  if (split === "shared") return "Mitad y mitad";
  return `Solo ${split === "alejo" ? "Alejo" : "Aleja"}`;
}

function oppositePerson(person: Person): Person {
  return person === "Alejo" ? "Aleja" : "Alejo";
}

function personalShare(expense: Expense, person: Person) {
  if (expense.split === "shared") return expense.amount / 2;
  if (expense.split === "alejo") return person === "Alejo" ? expense.amount : 0;
  return person === "Aleja" ? expense.amount : 0;
}

function debtCreatedByExpense(expense: Expense) {
  if (expense.type === "loan" || expense.type === "payment") {
    return {
      from: oppositePerson(expense.paidBy),
      to: expense.paidBy,
      amount: expense.amount,
    };
  }

  if (expense.split === "shared") {
    return {
      from: oppositePerson(expense.paidBy),
      to: expense.paidBy,
      amount: expense.amount / 2,
    };
  }

  const owner = expense.split === "alejo" ? "Alejo" : "Aleja";
  if (owner === expense.paidBy) return null;

  return { from: owner, to: expense.paidBy, amount: expense.amount };
}

function isPerson(value: unknown): value is Person {
  return value === "Alejo" || value === "Aleja";
}

function isSplitMode(value: unknown): value is SplitMode {
  return value === "shared" || value === "alejo" || value === "aleja";
}

function isMovementType(value: unknown): value is MovementType {
  return value === "expense" || value === "loan" || value === "payment";
}

function isReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== "object") return false;

  const receipt = value as Partial<Receipt>;
  return typeof receipt.name === "string" && typeof receipt.dataUrl === "string";
}

function normalizeExpense(value: unknown): Expense | null {
  if (!value || typeof value !== "object") return null;

  const raw = value as Partial<Expense>;
  const amount = Number(raw.amount);
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : "Movimiento sin descripcion";
  const date =
    typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
      ? raw.date
      : today;
  const type = isMovementType(raw.type) ? raw.type : "expense";

  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id
        : crypto.randomUUID(),
    type,
    description,
    amount,
    category:
      typeof raw.category === "string" && raw.category.trim()
        ? raw.category
        : type === "loan"
          ? "Prestamos"
          : type === "payment"
            ? "Pagos"
            : "Otros",
    paidBy: isPerson(raw.paidBy) ? raw.paidBy : "Alejo",
    split: isSplitMode(raw.split) ? raw.split : "shared",
    date,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    createdBy: typeof raw.createdBy === "string" ? raw.createdBy : undefined,
    createdByEmail:
      typeof raw.createdByEmail === "string" ? raw.createdByEmail : undefined,
    note: typeof raw.note === "string" ? raw.note : "",
    receipt: isReceipt(raw.receipt) ? raw.receipt : undefined,
    receiptName:
      typeof raw.receiptName === "string" ? raw.receiptName : undefined,
  };
}

function getStoredExpenses() {
  if (typeof window === "undefined") return [];

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((expense) => normalizeExpense(expense))
      .filter((expense): expense is Expense => Boolean(expense))
      .sort(sortNewestFirst);
  } catch {
    return [];
  }
}

function saveLocalExpenses(expenses: Expense[]) {
  if (typeof window === "undefined") return;

  try {
    const lightExpenses = expenses.map((expense) => ({
      ...expense,
      receipt: undefined,
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lightExpenses));
  } catch (error) {
    console.warn("No se pudo guardar el cache liviano de movimientos", error);
  }
}

type PendingSync = {
  upserts: Expense[];
  deletes: Expense[];
};

function getPendingSync(userId: string): PendingSync {
  if (typeof window === "undefined") return { upserts: [], deletes: [] };

  try {
    const stored = window.localStorage.getItem(`${SYNC_STORAGE_KEY}-${userId}`);
    if (!stored) return { upserts: [], deletes: [] };
    const parsed = JSON.parse(stored) as Partial<PendingSync>;
    const normalizeList = (items: unknown) =>
      Array.isArray(items)
        ? items
            .map((expense) => normalizeExpense(expense))
            .filter((expense): expense is Expense => Boolean(expense))
        : [];

    return {
      upserts: normalizeList(parsed.upserts),
      deletes: normalizeList(parsed.deletes),
    };
  } catch {
    return { upserts: [], deletes: [] };
  }
}

function savePendingSync(
  userId: string,
  upserts: Map<string, Expense>,
  deletes: Map<string, Expense>,
) {
  if (typeof window === "undefined") return;

  try {
    const pending: PendingSync = {
      upserts: Array.from(upserts.values()),
      deletes: Array.from(deletes.values()),
    };
    window.localStorage.setItem(
      `${SYNC_STORAGE_KEY}-${userId}`,
      JSON.stringify(pending),
    );
  } catch (error) {
    console.warn("No se pudo guardar la cola de sincronizacion", error);
    try {
      const lightPending: PendingSync = {
        upserts: Array.from(upserts.values()).map((expense) => ({
          ...expense,
          receipt: undefined,
        })),
        deletes: Array.from(deletes.values()).map((expense) => ({
          ...expense,
          receipt: undefined,
        })),
      };
      window.localStorage.setItem(
        `${SYNC_STORAGE_KEY}-${userId}`,
        JSON.stringify(lightPending),
      );
    } catch (fallbackError) {
      console.warn("No se pudo guardar la cola liviana", fallbackError);
    }
  }
}

function mergeExpenses(primary: Expense[], fallback: Expense[]) {
  const byId = new Map<string, Expense>();

  for (const expense of fallback) byId.set(expense.id, expense);
  for (const expense of primary) byId.set(expense.id, expense);

  return Array.from(byId.values()).sort(sortNewestFirst);
}

function movementTimestamp(expense: Expense) {
  return expense.createdAt ?? `${expense.date || today}T00:00:00.000`;
}

function sortNewestFirst(a: Expense, b: Expense) {
  const byCreated = movementTimestamp(b).localeCompare(movementTimestamp(a));
  if (byCreated !== 0) return byCreated;

  const byDate = (b.date || "").localeCompare(a.date || "");
  if (byDate !== 0) return byDate;

  return (b.id || "").localeCompare(a.id || "");
}

function formatMovementDate(expense: Expense) {
  if (!expense.createdAt) return expense.date;

  const createdAt = new Date(expense.createdAt);
  if (Number.isNaN(createdAt.getTime())) return expense.date;

  return `${expense.date} - ${createdAt.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

async function loadRemoteExpenses(onError?: (message: string) => void) {
  if (!supabase) return null;
  let hasSavedBatchMode = false;
  try {
    hasSavedBatchMode =
      typeof window !== "undefined" &&
      window.localStorage.getItem(BATCH_MODE_STORAGE_KEY) === "true";
  } catch {
    hasSavedBatchMode = false;
  }
  if (remoteBatchMode || hasSavedBatchMode) {
    remoteBatchMode = true;
    return loadRemoteExpensesInBatches(onError);
  }

  const { data, error } = await supabase
    .from("house_movements")
    .select(LIGHT_MOVEMENT_SELECT)
    .eq("household_id", HOUSEHOLD_ID)
    .order("movement_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("No se pudieron cargar movimientos de Supabase", error);
    if (error.code === "57014") {
      remoteBatchMode = true;
      try {
        window.localStorage.setItem(BATCH_MODE_STORAGE_KEY, "true");
      } catch {
        // The in-memory flag still avoids repeated heavy queries this session.
      }
      return loadRemoteExpensesInBatches(onError);
    }
    onError?.(`${error.message} (${error.code})`);
    return null;
  }

  return (data ?? [])
    .map((row) => normalizeExpense(row))
    .filter((expense): expense is Expense => Boolean(expense))
    .sort(sortNewestFirst);
}

async function loadRemoteExpensesInBatches(
  onError?: (message: string) => void,
) {
  if (!supabase) return null;

  const manifest = await supabase
    .from("house_movements")
    .select("id")
    .eq("household_id", HOUSEHOLD_ID)
    .order("movement_date", { ascending: false });

  if (manifest.error) {
    onError?.(`${manifest.error.message} (${manifest.error.code})`);
    return null;
  }

  const ids = (manifest.data ?? []).map((row) => row.id);
  const expenses: Expense[] = [];
  const batches: string[][] = [];

  for (let index = 0; index < ids.length; index += REMOTE_BATCH_SIZE) {
    batches.push(ids.slice(index, index + REMOTE_BATCH_SIZE));
  }

  for (
    let index = 0;
    index < batches.length;
    index += REMOTE_BATCH_CONCURRENCY
  ) {
    const group = batches.slice(index, index + REMOTE_BATCH_CONCURRENCY);
    const results = await Promise.all(
      group.map((batchIds) =>
        supabase
          .from("house_movements")
          .select(LIGHT_MOVEMENT_SELECT)
          .in("id", batchIds),
      ),
    );

    for (const batch of results) {
      if (batch.error) {
        console.warn("No se pudo cargar un lote de movimientos", batch.error);
        onError?.(`${batch.error.message} (${batch.error.code})`);
        return null;
      }

      for (const row of batch.data ?? []) {
        const expense = normalizeExpense(row);
        if (expense) expenses.push(expense);
      }
    }
  }

  return expenses.sort(sortNewestFirst);
}

async function loadRemoteReceipt(id: string) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("house_movements")
    .select("receipt:data->receipt")
    .eq("id", id)
    .eq("household_id", HOUSEHOLD_ID)
    .maybeSingle();

  if (error) {
    console.warn("No se pudo cargar la factura", error);
    return null;
  }

  return isReceipt(data?.receipt) ? data.receipt : null;
}

async function loadRemoteFingerprint() {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("house_movements")
    .select("id, updated_at")
    .eq("household_id", HOUSEHOLD_ID)
    .order("id", { ascending: true });

  if (error) {
    console.warn("No se pudo comprobar si hay movimientos nuevos", error);
    return null;
  }

  return JSON.stringify(data ?? []);
}

async function ensureActiveSession(): Promise<RemoteWriteResult> {
  if (!supabase) return { ok: true };

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    return {
      ok: false,
      error: error?.message ?? "La sesion vencio. Cierra sesion e ingresa de nuevo.",
    };
  }

  const expiresAt = (data.session.expires_at ?? 0) * 1000;
  if (expiresAt > Date.now() + 60000) return { ok: true };

  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) {
    return {
      ok: false,
      error:
        refreshed.error?.message ??
        "No se pudo renovar la sesion. Cierra sesion e ingresa de nuevo.",
    };
  }

  return { ok: true };
}

async function upsertRemoteExpense(
  expense: Expense,
): Promise<RemoteWriteResult> {
  if (!supabase) return { ok: true };
  const session = await ensureActiveSession();
  if (!session.ok) return session;

  const { error } = await supabase.from("house_movements").upsert({
    id: expense.id,
    household_id: HOUSEHOLD_ID,
    movement_date: expense.date,
    data: expense,
  });

  if (error) {
    console.warn("No se pudo guardar en Supabase", error);
    return { ok: false, error: `${error.message} (${error.code})` };
  }

  return { ok: true };
}

async function updateRemoteExpense(
  expense: Expense,
  previousExpense: Expense,
  userId: string,
  accountPerson?: Person,
): Promise<RemoteWriteResult> {
  if (!supabase) return { ok: true };
  const session = await ensureActiveSession();
  if (!session.ok) return session;

  let query = supabase
    .from("house_movements")
    .update({
      movement_date: expense.date,
      data: expense,
    })
    .eq("id", expense.id)
    .eq("household_id", HOUSEHOLD_ID);

  if (previousExpense.createdBy) {
    query = query.eq("data->>createdBy", userId);
  } else if (accountPerson) {
    query = query
      .is("data->>createdBy", null)
      .eq("data->>paidBy", accountPerson);
  } else {
    return { ok: false, error: "No se pudo identificar al propietario." };
  }

  const { data, error } = await query.select("id");

  if (error || !data?.length) {
    console.warn("No se pudo actualizar en Supabase", error);
    return {
      ok: false,
      error: error
        ? `${error.message} (${error.code})`
        : "Supabase no permitio actualizar este movimiento.",
    };
  }

  return { ok: true };
}

async function deleteRemoteExpense(
  expense: Expense,
  userId: string,
  accountPerson?: Person,
): Promise<RemoteWriteResult> {
  if (!supabase) return { ok: true };
  const session = await ensureActiveSession();
  if (!session.ok) return session;

  let query = supabase
    .from("house_movements")
    .delete()
    .eq("id", expense.id)
    .eq("household_id", HOUSEHOLD_ID);

  if (expense.createdBy) {
    query = query.eq("data->>createdBy", userId);
  } else if (accountPerson) {
    query = query
      .is("data->>createdBy", null)
      .eq("data->>paidBy", accountPerson);
  } else {
    return { ok: false, error: "No se pudo identificar al propietario." };
  }

  const { data, error } = await query.select("id");

  if (error || !data?.length) {
    console.warn("No se pudo eliminar en Supabase", error);
    return {
      ok: false,
      error: error
        ? `${error.message} (${error.code})`
        : "Supabase no permitio eliminar este movimiento.",
    };
  }

  return { ok: true };
}

function readReceipt(file: File) {
  return new Promise<Receipt>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({ name: file.name || "factura.jpg", dataUrl: String(reader.result) });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function compressReceipt(receipt: Receipt) {
  const image = await loadImage(receipt.dataUrl);
  const scale = Math.min(
    1,
    RECEIPT_MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight),
  );

  if (scale >= 1 && receipt.dataUrl.length < 650000) {
    return receipt;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext("2d");
  if (!context) return receipt;

  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return {
    name: receipt.name.replace(/\.[^.]+$/, "") || "factura",
    dataUrl: canvas.toDataURL("image/jpeg", RECEIPT_QUALITY),
  };
}

function csvCell(value: string | number) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function movementTypeLabel(expense: Expense) {
  if (expense.type === "loan") return "Prestamo";
  if (expense.type === "payment") return "Pago";
  return "Compra o gasto";
}

function expenseMonth(expense: Expense) {
  return expense.date.slice(0, 7);
}

function formatMonth(month: string) {
  const [year, monthIndex] = month.split("-").map(Number);
  const monthDate = new Date(year, monthIndex - 1, 1);

  if (Number.isNaN(monthDate.getTime())) return month;

  return monthDate.toLocaleDateString("es-CO", {
    month: "long",
    year: "numeric",
  });
}

function summarizeExpenses(expensesToSummarize: Expense[]) {
  const paid = { Alejo: 0, Aleja: 0 };
  const owed = { Alejo: 0, Aleja: 0 };
  const directDebts = { Alejo: 0, Aleja: 0 };
  const byCategory = new Map<string, number>();
  let sharedTotal = 0;
  let loanTotal = 0;

  for (const expense of expensesToSummarize) {
    const isLoan = expense.type === "loan";
    const isPayment = expense.type === "payment";

    if (isLoan) {
      loanTotal += expense.amount;
    }

    if (!isLoan && !isPayment) {
      paid[expense.paidBy] += expense.amount;
      owed.Alejo += personalShare(expense, "Alejo");
      owed.Aleja += personalShare(expense, "Aleja");
      byCategory.set(
        expense.category,
        (byCategory.get(expense.category) ?? 0) + expense.amount,
      );
      if (expense.split === "shared") sharedTotal += expense.amount;
    }

    const debt = debtCreatedByExpense(expense);
    if (debt) directDebts[debt.from] += debt.amount;
  }

  const categoryRows = Array.from(byCategory.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
  const alejoNet = directDebts.Aleja - directDebts.Alejo;
  const settle =
    alejoNet > 0
      ? { from: "Aleja", to: "Alejo", amount: alejoNet }
      : { from: "Alejo", to: "Aleja", amount: Math.abs(alejoNet) };

  return {
    total: expensesToSummarize.reduce((sum, expense) => sum + expense.amount, 0),
    paid,
    owed,
    directDebts,
    sharedTotal,
    loanTotal,
    categoryRows,
    topCategory: categoryRows[0],
    settle,
  };
}

export default function Home() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [draft, setDraft] = useState<ExpenseDraft>(initialDraft);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("Todas");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [analysisMonth, setAnalysisMonth] = useState(today.slice(0, 7));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("home");
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured);
  const [user, setUser] = useState<User | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [passwordPanelOpen, setPasswordPanelOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [viewingReceipt, setViewingReceipt] = useState<Receipt | null>(null);
  const [pendingUpsertIds, setPendingUpsertIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingUpsertsRef = useRef(new Map<string, Expense>());
  const pendingDeletesRef = useRef(new Map<string, Expense>());
  const acceptedUpsertsRef = useRef(new Map<string, Expense>());
  const acceptedDeletesRef = useRef(new Set<string>());
  const refreshSequenceRef = useRef(0);
  const remoteFingerprintRef = useRef<string | null>(null);
  const accountPerson = isPerson(user?.user_metadata?.person)
    ? user.user_metadata.person
    : undefined;
  const reportRemoteLoadError = useCallback((message: string) => {
    setSyncMessage(
      `No se pudieron cargar los movimientos compartidos. Supabase respondio: ${message}`,
    );
  }, []);

  const persistPendingSync = useCallback(() => {
    setPendingUpsertIds(new Set(pendingUpsertsRef.current.keys()));
    if (!user?.id) return;
    savePendingSync(
      user.id,
      pendingUpsertsRef.current,
      pendingDeletesRef.current,
    );
  }, [user]);

  const mergeRemoteWithPending = useCallback((remoteExpenses: Expense[]) => {
    const remoteById = new Map(
      remoteExpenses.map((expense) => [expense.id, expense] as const),
    );

    for (const [id, pending] of pendingUpsertsRef.current) {
      const remote = remoteById.get(id);
      if (
        remote &&
        (pending.updatedAt
          ? remote.updatedAt === pending.updatedAt
          : remote.createdAt === pending.createdAt)
      ) {
        pendingUpsertsRef.current.delete(id);
      }
    }

    for (const [id, accepted] of acceptedUpsertsRef.current) {
      const remote = remoteById.get(id);
      if (
        remote &&
        (accepted.updatedAt
          ? remote.updatedAt === accepted.updatedAt
          : remote.createdAt === accepted.createdAt)
      ) {
        acceptedUpsertsRef.current.delete(id);
      }
    }

    for (const id of pendingDeletesRef.current.keys()) {
      if (!remoteById.has(id)) pendingDeletesRef.current.delete(id);
    }
    for (const id of acceptedDeletesRef.current) {
      if (!remoteById.has(id)) acceptedDeletesRef.current.delete(id);
    }

    persistPendingSync();
    if (
      pendingUpsertsRef.current.size === 0 &&
      pendingDeletesRef.current.size === 0
    ) {
      setSyncMessage((current) =>
        current.includes("Supabase respondio") ? "" : current,
      );
    }

    const withoutPendingDeletes = remoteExpenses.filter(
      (expense) =>
        !pendingDeletesRef.current.has(expense.id) &&
        !acceptedDeletesRef.current.has(expense.id),
    );

    return mergeExpenses(
      [
        ...pendingUpsertsRef.current.values(),
        ...acceptedUpsertsRef.current.values(),
      ],
      withoutPendingDeletes,
    );
  }, [persistPendingSync]);

  const markUpsertAccepted = useCallback(
    (expense: Expense) => {
      pendingUpsertsRef.current.delete(expense.id);
      acceptedUpsertsRef.current.set(expense.id, expense);
      persistPendingSync();
    },
    [persistPendingSync],
  );

  const markDeleteAccepted = useCallback(
    (expense: Expense) => {
      pendingDeletesRef.current.delete(expense.id);
      acceptedDeletesRef.current.add(expense.id);
      persistPendingSync();
    },
    [persistPendingSync],
  );

  const flushPendingChanges = useCallback(async () => {
    if (!user) return;

    const upserts = Array.from(pendingUpsertsRef.current.values());
    const deletes = Array.from(pendingDeletesRef.current.values());

    const upsertResults = await Promise.all(
      upserts.map(async (expense) => ({
        expense,
        result: await upsertRemoteExpense(expense),
      })),
    );
    const deleteResults = await Promise.all(
      deletes.map(async (expense) => ({
        expense,
        result: await deleteRemoteExpense(expense, user.id, accountPerson),
      })),
    );

    for (const { expense, result } of upsertResults) {
      if (result.ok) markUpsertAccepted(expense);
    }
    for (const { expense, result } of deleteResults) {
      if (result.ok) markDeleteAccepted(expense);
    }

    const failed = [...upsertResults, ...deleteResults].find(
      ({ result }) => !result.ok,
    )?.result;
    if (failed) {
      setSyncMessage(
        `Hay cambios pendientes. Supabase respondio: ${failed.error ?? "error desconocido"}`,
      );
    }
  }, [accountPerson, markDeleteAccepted, markUpsertAccepted, user]);

  function canManageExpense(expense: Expense) {
    if (!isSupabaseConfigured) return true;
    if (user?.id && expense.createdBy === user.id) return true;
    return Boolean(!expense.createdBy && accountPerson === expense.paidBy);
  }

  async function saveAccountPerson(person: Person) {
    if (!supabase) return;
    setProfileSaving(true);
    setSyncMessage("");
    const { data, error } = await supabase.auth.updateUser({
      data: { person },
    });
    setProfileSaving(false);

    if (error || !data.user) {
      setSyncMessage("No se pudo guardar quien usa esta cuenta. Intenta otra vez.");
      return;
    }

    setUser(data.user);
    setSyncMessage(`Esta cuenta quedo asignada a ${person}.`);
  }

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setAuthReady(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthReady(true);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!authReady) return;

    async function loadExpenses() {
      const requestId = ++refreshSequenceRef.current;
      if (isSupabaseConfigured && !user) {
        setExpenses(getStoredExpenses());
        setHasLoaded(false);
        return;
      }

      const localExpenses = getStoredExpenses();
      if (user?.id) {
        const pending = getPendingSync(user.id);
        pendingUpsertsRef.current = new Map(
          pending.upserts.map((expense) => [expense.id, expense]),
        );
        pendingDeletesRef.current = new Map(
          pending.deletes.map((expense) => [expense.id, expense]),
        );
        setPendingUpsertIds(new Set(pendingUpsertsRef.current.keys()));
      }

      const localWithPending = mergeExpenses(
        Array.from(pendingUpsertsRef.current.values()),
        localExpenses.filter(
          (expense) => !pendingDeletesRef.current.has(expense.id),
        ),
      );
      setExpenses(localWithPending);
      setHasLoaded(true);

      await flushPendingChanges();

      const remoteExpenses = isSupabaseConfigured
        ? await loadRemoteExpenses(reportRemoteLoadError)
        : null;

      if (requestId === refreshSequenceRef.current && remoteExpenses) {
        const nextExpenses = mergeRemoteWithPending(remoteExpenses);
        setExpenses(nextExpenses);
        saveLocalExpenses(nextExpenses);
      }
    }

    void loadExpenses();
  }, [
    authReady,
    flushPendingChanges,
    mergeRemoteWithPending,
    reportRemoteLoadError,
    user,
  ]);

  useEffect(() => {
    if (hasLoaded) saveLocalExpenses(expenses);
  }, [expenses, hasLoaded]);

  useEffect(() => {
    if (!authReady || !user || !isSupabaseConfigured) return;

    let isMounted = true;

    async function refreshFromRemote() {
      const requestId = ++refreshSequenceRef.current;
      await flushPendingChanges();
      const remoteExpenses = await loadRemoteExpenses(reportRemoteLoadError);
      if (
        !isMounted ||
        requestId !== refreshSequenceRef.current ||
        !remoteExpenses
      ) {
        return;
      }

      const nextExpenses = mergeRemoteWithPending(remoteExpenses);
      setExpenses(nextExpenses);
      saveLocalExpenses(nextExpenses);
    }

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") {
        void refreshFromRemote();
      }
    }

    async function checkForRemoteChanges() {
      const fingerprint = await loadRemoteFingerprint();
      if (!isMounted || fingerprint === null) return;

      const hasPendingChanges =
        pendingUpsertsRef.current.size > 0 ||
        pendingDeletesRef.current.size > 0;
      if (
        fingerprint === remoteFingerprintRef.current &&
        !hasPendingChanges
      ) {
        return;
      }

      remoteFingerprintRef.current = fingerprint;
      await refreshFromRemote();
    }

    const intervalId = window.setInterval(
      checkForRemoteChanges,
      REMOTE_SYNC_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshFromRemote);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const channel = supabase
      .channel(`house-movements-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "house_movements",
          filter: `household_id=eq.${HOUSEHOLD_ID}`,
        },
        () => void refreshFromRemote(),
      )
      .subscribe();

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshFromRemote);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      void supabase.removeChannel(channel);
    };
  }, [
    authReady,
    flushPendingChanges,
    mergeRemoteWithPending,
    reportRemoteLoadError,
    user,
  ]);

  const totals = useMemo(() => summarizeExpenses(expenses), [expenses]);

  const currentMonthTotals = useMemo(
    () =>
      summarizeExpenses(
        expenses.filter(
          (expense) => expenseMonth(expense) === today.slice(0, 7),
        ),
      ),
    [expenses],
  );

  const analysisExpenses = useMemo(
    () => expenses.filter((expense) => expenseMonth(expense) === analysisMonth),
    [analysisMonth, expenses],
  );

  const analysisTotals = useMemo(
    () => summarizeExpenses(analysisExpenses),
    [analysisExpenses],
  );

  const analysisMonthOptions = useMemo(() => {
    const months = new Set([today.slice(0, 7)]);
    for (const expense of expenses) months.add(expenseMonth(expense));
    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [expenses]);

  const newestExpenses = useMemo(
    () => expenses.slice().sort(sortNewestFirst),
    [expenses],
  );

  const filteredExpenses = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    return newestExpenses
      .slice()
      .filter((expense) => {
        const matchesCategory =
          categoryFilter === "Todas" || expense.category === categoryFilter;
        const matchesDateFrom = !dateFrom || expense.date >= dateFrom;
        const matchesDateTo = !dateTo || expense.date <= dateTo;
        const matchesQuery =
          !normalized ||
          expense.description.toLowerCase().includes(normalized) ||
          expense.note.toLowerCase().includes(normalized);
        return matchesCategory && matchesDateFrom && matchesDateTo && matchesQuery;
      });
  }, [categoryFilter, dateFrom, dateTo, newestExpenses, query]);

  function updateDraft<K extends keyof ExpenseDraft>(
    key: K,
    value: ExpenseDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function attachReceipt(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const receipt = await readReceipt(file);
    updateDraft("receipt", await compressReceipt(receipt));
    event.target.value = "";
  }

  async function addExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSyncMessage("");
    const amount = Number(draft.amount);
    if (!draft.description.trim() || !Number.isFinite(amount) || amount <= 0) {
      return;
    }

    const existingExpense = editingId
      ? expenses.find((expense) => expense.id === editingId)
      : undefined;
    if (editingId && (!existingExpense || !canManageExpense(existingExpense))) {
      setIsModalOpen(false);
      setEditingId(null);
      setSyncMessage("Solo puedes editar los movimientos que registraste tu.");
      return;
    }

    const savedExpense: Expense = {
      ...draft,
      id: editingId ?? crypto.randomUUID(),
      createdAt: existingExpense?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: existingExpense?.createdBy ?? user?.id ?? "local-user",
      createdByEmail: existingExpense?.createdByEmail ?? user?.email ?? undefined,
      description: draft.description.trim(),
      category:
        draft.type === "loan"
          ? "Prestamos"
          : draft.type === "payment"
            ? "Pagos"
            : draft.category,
      note: draft.note.trim(),
      amount,
      receipt: draft.type === "expense" ? draft.receipt : undefined,
    };

    pendingUpsertsRef.current.set(savedExpense.id, savedExpense);
    pendingDeletesRef.current.delete(savedExpense.id);
    persistPendingSync();
    setExpenses((current) =>
      editingId
        ? current.map((expense) =>
            expense.id === editingId ? savedExpense : expense,
          )
        : [savedExpense, ...current],
    );
    setDraft({ ...initialDraft, paidBy: draft.paidBy, date: today });
    setEditingId(null);
    setIsModalOpen(false);

    const savedRemote = existingExpense
      ? await updateRemoteExpense(
          savedExpense,
          existingExpense,
          user?.id ?? "local-user",
          accountPerson,
        )
      : await upsertRemoteExpense(savedExpense);

    if (!savedRemote.ok) {
      setSyncMessage(
        `El movimiento quedo guardado en este celular. Supabase respondio: ${savedRemote.error ?? "error desconocido"}`,
      );
      return;
    }
    markUpsertAccepted(savedExpense);

    const remoteExpenses = await loadRemoteExpenses(reportRemoteLoadError);
    if (remoteExpenses) {
      const nextExpenses = mergeRemoteWithPending(remoteExpenses);
      setExpenses(nextExpenses);
      saveLocalExpenses(nextExpenses);
    }
  }

  async function removeExpense(id: string) {
    setSyncMessage("");
    const expenseToRemove = expenses.find((expense) => expense.id === id);
    if (!expenseToRemove || !canManageExpense(expenseToRemove)) {
      setSyncMessage("Solo puedes eliminar los movimientos que registraste tu.");
      return;
    }

    pendingUpsertsRef.current.delete(id);
    pendingDeletesRef.current.set(id, expenseToRemove);
    persistPendingSync();
    setExpenses((current) => current.filter((expense) => expense.id !== id));

    const deletedRemote = await deleteRemoteExpense(
      expenseToRemove,
      user?.id ?? "local-user",
      accountPerson,
    );
    if (!deletedRemote.ok) {
      setSyncMessage(
        `La eliminacion quedo pendiente. Supabase respondio: ${deletedRemote.error ?? "error desconocido"}`,
      );
      return;
    }
    markDeleteAccepted(expenseToRemove);

    const remoteExpenses = await loadRemoteExpenses(reportRemoteLoadError);
    if (remoteExpenses) {
      const nextExpenses = mergeRemoteWithPending(remoteExpenses);
      setExpenses(nextExpenses);
      saveLocalExpenses(nextExpenses);
    }
  }

  function openNewMovement() {
    setDraft({ ...initialDraft, date: today });
    setEditingId(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    setDraft({ ...initialDraft, date: today });
    setEditingId(null);
    setIsModalOpen(false);
  }

  async function editExpense(expense: Expense) {
    if (!canManageExpense(expense)) {
      setSyncMessage("Solo puedes editar los movimientos que registraste tu.");
      return;
    }

    const receipt =
      expense.receipt ??
      (expense.receiptName ? await loadRemoteReceipt(expense.id) : undefined);

    setDraft({
      type: expense.type ?? "expense",
      description: expense.description,
      amount: String(expense.amount),
      category: expense.category,
      paidBy: expense.paidBy,
      split: expense.split,
      date: expense.date,
      note: expense.note,
      receipt: receipt ?? undefined,
    });
    setEditingId(expense.id);
    setIsModalOpen(true);
  }

  async function viewExpenseReceipt(expense: Expense) {
    if (expense.receipt) {
      setViewingReceipt(expense.receipt);
      return;
    }

    const receipt = await loadRemoteReceipt(expense.id);
    if (!receipt) {
      setSyncMessage("No se pudo cargar la factura. Revisa la conexion e intenta de nuevo.");
      return;
    }

    setViewingReceipt(receipt);
  }

  async function registerSettlementPayment() {
    if (!hasBalance) return;
    setSyncMessage("");
    const from = totals.settle.from as Person;
    const to = totals.settle.to as Person;
    const payment: Expense = {
      id: crypto.randomUUID(),
      type: "payment",
      description: `Pago de saldo a ${to}`,
      amount: totals.settle.amount,
      category: "Pagos",
      paidBy: from,
      split: from === "Alejo" ? "alejo" : "aleja",
      date: today,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: user?.id ?? "local-user",
      createdByEmail: user?.email ?? undefined,
      note: `Pago para quedar a paces con ${to}.`,
    };

    pendingUpsertsRef.current.set(payment.id, payment);
    persistPendingSync();
    setExpenses((current) => [payment, ...current]);

    const savedRemote = await upsertRemoteExpense(payment);

    if (!savedRemote.ok) {
      setSyncMessage(
        `El pago quedo guardado en este celular. Supabase respondio: ${savedRemote.error ?? "error desconocido"}`,
      );
      return;
    }
    markUpsertAccepted(payment);

    const remoteExpenses = await loadRemoteExpenses(reportRemoteLoadError);
    if (remoteExpenses) {
      const nextExpenses = mergeRemoteWithPending(remoteExpenses);
      setExpenses(nextExpenses);
      saveLocalExpenses(nextExpenses);
    }
  }

  function exportToExcel() {
    const headers = [
      "Fecha",
      "Registrado",
      "Tipo",
      "Descripcion",
      "Categoria",
      "Valor",
      "Persona que pago/presto",
      "Forma de reparto",
      "Debe",
      "A quien",
      "Valor deuda",
      "Nota",
      "Tiene factura",
    ];
    const rows = filteredExpenses.map((expense) => {
      const debt = debtCreatedByExpense(expense);
      return [
        expense.date,
        expense.createdAt ?? "",
        movementTypeLabel(expense),
        expense.description,
        expense.category,
        expense.amount,
        expense.paidBy,
        expense.type === "expense" || !expense.type ? splitLabel(expense.split) : "",
        debt?.from ?? "",
        debt?.to ?? "",
        debt?.amount ?? "",
        expense.note,
        expense.receipt ? "Si" : "No",
      ];
    });
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => csvCell(cell)).join(";"))
      .join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `movimientos-aleja-alejo-${today}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function signOut() {
    await supabase?.auth.signOut();
    setHasLoaded(false);
    setExpenses([]);
    pendingUpsertsRef.current.clear();
    pendingDeletesRef.current.clear();
    acceptedUpsertsRef.current.clear();
    acceptedDeletesRef.current.clear();
    setPendingUpsertIds(new Set());
    setEditingId(null);
    setIsModalOpen(false);
    setSessionMenuOpen(false);
    setPasswordPanelOpen(false);
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage("");

    if (!supabase || newPassword.length < 6) {
      setPasswordMessage("La clave debe tener minimo 6 caracteres.");
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setPasswordMessage(error.message);
      return;
    }

    setNewPassword("");
    setPasswordMessage("Clave actualizada.");
  }

  async function clearAll() {
    const ownExpenses = expenses.filter(canManageExpense);
    if (ownExpenses.length === 0) {
      setSyncMessage("No tienes movimientos propios para eliminar.");
      return;
    }
    if (window.confirm("Borrar todos los movimientos que registraste tu?")) {
      for (const expense of ownExpenses) {
        pendingUpsertsRef.current.delete(expense.id);
        pendingDeletesRef.current.set(expense.id, expense);
      }
      persistPendingSync();
      const ownIds = new Set(ownExpenses.map((expense) => expense.id));
      setExpenses((current) =>
        current.filter((expense) => !ownIds.has(expense.id)),
      );

      await flushPendingChanges();
      const remoteExpenses = await loadRemoteExpenses(reportRemoteLoadError);
      if (remoteExpenses) {
        const nextExpenses = mergeRemoteWithPending(remoteExpenses);
        setExpenses(nextExpenses);
        saveLocalExpenses(nextExpenses);
      }
    }
  }

  const maxCategoryAmount = analysisTotals.categoryRows[0]?.amount ?? 0;
  const hasBalance = totals.settle.amount > 0.5;

  if (isSupabaseConfigured && !authReady) {
    return (
      <main className="app-shell min-h-screen text-[#20211d]">
        <div className="auth-shell">
          <section className="auth-card">
            <h1>Aleja & Alejo</h1>
            <p>Cargando sesion...</p>
          </section>
        </div>
      </main>
    );
  }

  if (isSupabaseConfigured && !user) {
    return <AuthScreen />;
  }

  return (
    <main className="app-shell min-h-screen text-[#20211d]">
      <section className="app-hero border-b border-white/40">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#736352]">
                Casa compartida
              </p>
              <h1 className="mt-1 text-3xl font-bold">Aleja & Alejo</h1>
            </div>
            <div className="session-area">
              <button className="small-action" type="button" onClick={openNewMovement}>
                Registrar
              </button>
              <button
                className="avatar-button"
                type="button"
                onClick={() => setSessionMenuOpen((current) => !current)}
                aria-label="Abrir sesion"
              >
                {user?.email?.slice(0, 1).toUpperCase() ?? "U"}
              </button>
              {sessionMenuOpen ? (
                <div className="session-menu">
                  <p>{user?.email}</p>
                  <div className="account-person-control">
                    <span>Esta cuenta es de:</span>
                    <div>
                      {people.map((person) => (
                        <button
                          className={accountPerson === person ? "active" : ""}
                          disabled={profileSaving}
                          key={person}
                          type="button"
                          onClick={() => void saveAccountPerson(person)}
                        >
                          {person}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPasswordPanelOpen((current) => !current);
                      setPasswordMessage("");
                    }}
                  >
                    Cambiar contrasena
                  </button>
                  {passwordPanelOpen ? (
                    <form className="password-form" onSubmit={changePassword}>
                      <input
                        className="field"
                        minLength={6}
                        placeholder="Nueva clave"
                        type="password"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                      />
                      <button type="submit">Guardar clave</button>
                      {passwordMessage ? <span>{passwordMessage}</span> : null}
                    </form>
                  ) : null}
                  <button type="button" onClick={signOut}>
                    Cerrar sesion
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-4 sm:px-6">
        {!accountPerson && expenses.some((expense) => !expense.createdBy) ? (
          <section className="identity-setup" aria-labelledby="identity-title">
            <div>
              <h2 id="identity-title">¿Quien usa esta cuenta?</h2>
              <p>
                Elige una vez para recuperar editar y eliminar en tus movimientos
                anteriores.
              </p>
            </div>
            <div className="identity-options">
              {people.map((person) => (
                <button
                  disabled={profileSaving}
                  key={person}
                  type="button"
                  onClick={() => void saveAccountPerson(person)}
                >
                  Soy {person}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {syncMessage ? (
          <div className="sync-message" role="status">
            {syncMessage}
          </div>
        ) : null}

        {activeTab === "home" ? (
          <section className="tab-panel">
            <div className="hero-balance">
              <p>Saldo final</p>
              <strong>
                {hasBalance
                  ? currency.format(totals.settle.amount)
                  : "Estamos tablas"}
              </strong>
              <span>
                {hasBalance
                  ? `${totals.settle.from} le paga a ${totals.settle.to}`
                  : "No hay deuda entre ustedes"}
              </span>
              {hasBalance ? (
                <button type="button" onClick={registerSettlementPayment}>
                  Pagar y quedar a paces
                </button>
              ) : null}
            </div>
            <div className="quick-grid">
              <Metric
                label="Total del mes"
                value={currency.format(currentMonthTotals.total)}
              />
              <Metric
                label="Compartidos del mes"
                value={currency.format(currentMonthTotals.sharedTotal)}
              />
              <Metric
                label="Prestamos del mes"
                value={currency.format(currentMonthTotals.loanTotal)}
              />
              <Metric
                label="Top categoria del mes"
                value={currentMonthTotals.topCategory?.category ?? "Sin datos"}
              />
            </div>
            <section className="rounded-lg border border-[#ded6c8] bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-bold">Ultimos movimientos</h2>
                <button
                  className="text-sm font-semibold text-[#273c35]"
                  type="button"
                  onClick={() => setActiveTab("movements")}
                >
                  Ver todos
                </button>
              </div>
              <div className="mt-4 grid gap-3">
                {newestExpenses.length === 0 ? (
                  <EmptyState text="Registra el primer movimiento para empezar." />
                ) : (
                  newestExpenses.slice(0, 3).map((expense) => (
                    <ExpenseRow
                      canManage={canManageExpense(expense)}
                      expense={expense}
                      isPending={pendingUpsertIds.has(expense.id)}
                      key={expense.id}
                      onEdit={editExpense}
                      onRemove={removeExpense}
                      onViewReceipt={viewExpenseReceipt}
                    />
                  ))
                )}
              </div>
            </section>
          </section>
        ) : null}

        {activeTab === "accounts" ? (
          <section className="tab-panel">
            <div className="grid gap-3 sm:grid-cols-2">
              {people.map((person) => (
                <div
                  className="rounded-lg border border-[#ded6c8] bg-white p-4 shadow-sm"
                  key={person}
                >
                  <p className="text-sm font-semibold text-[#736352]">{person}</p>
                  <p className="mt-2 text-2xl font-bold">
                    {currency.format(totals.owed[person])}
                  </p>
                  <p className="mt-1 text-sm text-[#615b52]">
                    Pagado: {currency.format(totals.paid[person])}
                  </p>
                </div>
              ))}
            </div>
            <section className="rounded-lg border border-[#ded6c8] bg-white p-4 shadow-sm">
              <h2 className="text-xl font-bold">Cruce de cuentas</h2>
              <div className="mt-4 grid gap-3">
                <div className="balance-line">
                  <p>Aleja le debe a Alejo</p>
                  <strong>{currency.format(totals.directDebts.Aleja)}</strong>
                </div>
                <div className="balance-line">
                  <p>Alejo le debe a Aleja</p>
                  <strong>{currency.format(totals.directDebts.Alejo)}</strong>
                </div>
                <div className="balance-line final">
                  <p>Despues de cruzar</p>
                  <strong>
                    {hasBalance
                      ? `${totals.settle.from} paga ${currency.format(totals.settle.amount)}`
                      : "Nadie debe nada"}
                  </strong>
                  <span>
                    {hasBalance
                      ? `Ese valor va para ${totals.settle.to}.`
                      : "Los pagos quedaron compensados."}
                  </span>
                </div>
              </div>
            </section>
          </section>
        ) : null}

        {activeTab === "analysis" ? (
          <section className="tab-panel">
            <section className="rounded-lg border border-[#ded6c8] bg-white p-4 shadow-sm">
              <div className="analysis-header">
                <div>
                  <h2 className="text-xl font-bold">En que gastamos mas</h2>
                  <p className="text-sm text-[#615b52]">
                    Comparacion por categoria segun la fecha de compra.
                  </p>
                </div>
                <label className="month-filter">
                  Mes
                  <select
                    className="field"
                    value={analysisMonth}
                    onChange={(event) => setAnalysisMonth(event.target.value)}
                  >
                    {analysisMonthOptions.map((month) => (
                      <option key={month} value={month}>
                        {formatMonth(month)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="analysis-summary">
                <Metric
                  label="Total del mes"
                  value={currency.format(analysisTotals.total)}
                />
                <Metric
                  label="Top categoria"
                  value={analysisTotals.topCategory?.category ?? "Sin datos"}
                />
              </div>
              <div className="mt-4 grid gap-3">
                {analysisTotals.categoryRows.length === 0 ? (
                  <EmptyState text="No hay compras registradas para este mes." />
                ) : (
                  analysisTotals.categoryRows.map((row) => (
                    <div className="grid gap-2" key={row.category}>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold">{row.category}</span>
                        <span>{currency.format(row.amount)}</span>
                      </div>
                      <div className="h-3 overflow-hidden rounded-full bg-[#eee6da]">
                        <div
                          className="h-full rounded-full bg-[#d56b3d]"
                          style={{
                            width: `${Math.max(
                              8,
                              (row.amount / maxCategoryAmount) * 100,
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </section>
        ) : null}

        {activeTab === "movements" ? (
          <section className="tab-panel">
            <section className="rounded-lg border border-[#ded6c8] bg-white p-4 shadow-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-semibold">
                  Buscar
                  <input
                    className="field"
                    placeholder="Nombre o nota"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  Categoria
                  <select
                    className="field"
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                  >
                    <option>Todas</option>
                    {categories.map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                    <option>Prestamos</option>
                    <option>Pagos</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  Desde
                  <input
                    className="field"
                    type="date"
                    value={dateFrom}
                    onChange={(event) => setDateFrom(event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  Hasta
                  <input
                    className="field"
                    type="date"
                    value={dateTo}
                    onChange={(event) => setDateTo(event.target.value)}
                  />
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="export-button" type="button" onClick={exportToExcel}>
                  Exportar Excel
                </button>
                <button className="small-action" type="button" onClick={clearAll}>
                  Eliminar mis movimientos
                </button>
              </div>
            </section>
            <div className="grid gap-3">
              {filteredExpenses.length === 0 ? (
                <EmptyState text="No hay gastos para mostrar con este filtro." />
              ) : (
                filteredExpenses.map((expense) => (
                  <ExpenseRow
                    canManage={canManageExpense(expense)}
                    expense={expense}
                    isPending={pendingUpsertIds.has(expense.id)}
                    key={expense.id}
                    onEdit={editExpense}
                    onRemove={removeExpense}
                    onViewReceipt={viewExpenseReceipt}
                  />
                ))
              )}
            </div>
          </section>
        ) : null}
      </div>

      <button className="fab" type="button" onClick={openNewMovement}>
        +
      </button>

      <nav className="bottom-tabs" aria-label="Secciones">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab.id ? "active" : ""}
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {isModalOpen ? (
        <ExpenseModal
          draft={draft}
          isEditing={Boolean(editingId)}
          onAttachReceipt={attachReceipt}
          onClose={closeModal}
          onRemoveReceipt={() => updateDraft("receipt", undefined)}
          onSubmit={addExpense}
          onUpdate={updateDraft}
        />
      ) : null}

      {viewingReceipt ? (
        <ReceiptViewer
          receipt={viewingReceipt}
          onClose={() => setViewingReceipt(null)}
        />
      ) : null}
    </main>
  );
}

function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function isNetworkError(errorMessage: string) {
    return /load failed|failed to fetch|network|fetch/i.test(errorMessage);
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setIsSubmitting(true);

    if (!supabase) {
      setMessage("Supabase no esta configurado.");
      setIsSubmitting(false);
      return;
    }

    let result = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    for (let attempt = 2; attempt <= 3 && result.error; attempt += 1) {
      if (!isNetworkError(result.error.message)) break;
      setMessage(`Reconectando con Supabase (${attempt}/3)...`);
      await new Promise((resolve) => window.setTimeout(resolve, attempt * 700));
      result = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
    }

    setIsSubmitting(false);

    if (result.error) {
      setMessage(
        isNetworkError(result.error.message)
          ? "El celular no pudo conectarse con Supabase. Prueba cambiar entre wifi y datos moviles, y desactiva temporalmente VPN o bloqueadores de contenido."
          : result.error.message,
      );
      return;
    }

    setMessage("Listo.");
  }

  return (
    <main className="app-shell min-h-screen text-[#20211d]">
      <div className="auth-shell">
        <section className="auth-card">
          <p>Casa compartida</p>
          <h1>Aleja & Alejo</h1>
          <span>
            Ingresa con el usuario creado en Supabase. Las cuentas nuevas solo
            las crea el administrador.
          </span>

          <form className="auth-form" onSubmit={submitAuth}>
            <label>
              Correo
              <input
                className="field"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Clave
              <input
                className="field"
                type="password"
                minLength={6}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Un momento..." : "Entrar"}
            </button>
          </form>

          {message ? <div className="auth-message">{message}</div> : null}
        </section>
      </div>
    </main>
  );
}

function ExpenseModal({
  draft,
  isEditing,
  onAttachReceipt,
  onClose,
  onRemoveReceipt,
  onSubmit,
  onUpdate,
}: {
  draft: ExpenseDraft;
  isEditing: boolean;
  onAttachReceipt: (event: ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void;
  onRemoveReceipt: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUpdate: <K extends keyof ExpenseDraft>(
    key: K,
    value: ExpenseDraft[K],
  ) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-label="Registrar movimiento"
        aria-modal="true"
        className="expense-modal"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">
              {isEditing ? "Editar movimiento" : "Registrar movimiento"}
            </h2>
            <p className="mt-1 text-sm text-[#615b52]">
              Elige si fue un gasto de casa o plata prestada entre ustedes.
            </p>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <form className="mt-5 grid gap-4" onSubmit={onSubmit}>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">Tipo de movimiento</legend>
            <div className="segmented">
              {(["expense", "loan"] as MovementType[]).map((type) => (
                <button
                  className={draft.type === type ? "active" : ""}
                  key={type}
                  type="button"
                  onClick={() => {
                    onUpdate("type", type);
                    onUpdate("category", type === "loan" ? "Prestamos" : "Comida");
                  }}
                >
                  {type === "expense" ? "Compra o gasto" : "Prestamo"}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="grid gap-1 text-sm font-semibold">
            Descripcion
            <input
              className="field"
              placeholder={
                draft.type === "loan"
                  ? "Ej: plata prestada para taxi"
                  : "Ej: mercado, luz, arriendo"
              }
              value={draft.description}
              onChange={(event) => onUpdate("description", event.target.value)}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold">
              Valor
              <input
                className="field"
                inputMode="numeric"
                min="0"
                placeholder="0"
                type="number"
                value={draft.amount}
                onChange={(event) => onUpdate("amount", event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold">
              Fecha
              <input
                className="field"
                type="date"
                value={draft.date}
                onChange={(event) => onUpdate("date", event.target.value)}
              />
            </label>
          </div>

          {draft.type === "expense" ? (
            <label className="grid gap-1 text-sm font-semibold">
              Categoria
              <select
                className="field"
                value={draft.category}
                onChange={(event) => onUpdate("category", event.target.value)}
              >
                {categories.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
          ) : null}

          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">
              {draft.type === "loan" ? "Quien presto la plata" : "Pago"}
            </legend>
            <div className="segmented">
              {people.map((person) => (
                <button
                  className={draft.paidBy === person ? "active" : ""}
                  key={person}
                  type="button"
                  onClick={() => onUpdate("paidBy", person)}
                >
                  {person}
                </button>
              ))}
            </div>
          </fieldset>

          {draft.type === "expense" ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold">Quien asume</legend>
              <div className="segmented split">
                {(["shared", "alejo", "aleja"] as SplitMode[]).map((mode) => (
                  <button
                    className={draft.split === mode ? "active" : ""}
                    key={mode}
                    type="button"
                    onClick={() => onUpdate("split", mode)}
                  >
                    {splitLabel(mode)}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : (
            <div className="loan-note">
              {oppositePerson(draft.paidBy)} queda debiendo el valor completo a{" "}
              {draft.paidBy}.
            </div>
          )}

          <label className="grid gap-1 text-sm font-semibold">
            Nota
            <textarea
              className="field min-h-20 resize-none"
              placeholder="Opcional"
              value={draft.note}
              onChange={(event) => onUpdate("note", event.target.value)}
            />
          </label>

          {draft.type === "expense" ? (
            <div className="receipt-box">
              <div className="receipt-actions">
                <label className="receipt-button">
                  Tomar foto
                  <input
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    type="file"
                    onChange={onAttachReceipt}
                  />
                </label>
                <label className="receipt-button secondary">
                  Elegir de galeria
                  <input
                    accept="image/*"
                    className="sr-only"
                    type="file"
                    onChange={onAttachReceipt}
                  />
                </label>
              </div>
              {draft.receipt ? (
                <div className="receipt-preview">
                  <img alt="Factura adjunta" src={draft.receipt.dataUrl} />
                  <div>
                    <p>{draft.receipt.name}</p>
                    <button type="button" onClick={onRemoveReceipt}>
                      Quitar factura
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-[#615b52]">
                  Puedes tomar la foto o escoger una imagen guardada.
                </p>
              )}
            </div>
          ) : null}

          <button
            className="h-12 rounded-md bg-[#273c35] px-4 text-base font-bold text-white transition hover:bg-[#1c2d27]"
            type="submit"
          >
            {isEditing
              ? "Guardar cambios"
              : draft.type === "loan"
                ? "Guardar prestamo"
                : "Guardar gasto"}
          </button>
        </form>
      </section>
    </div>
  );
}

function ExpenseRow({
  canManage,
  expense,
  isPending,
  onEdit,
  onRemove,
  onViewReceipt,
}: {
  canManage: boolean;
  expense: Expense;
  isPending: boolean;
  onEdit: (expense: Expense) => void;
  onRemove: (id: string) => void;
  onViewReceipt: (expense: Expense) => void;
}) {
  const debt = debtCreatedByExpense(expense);
  const isLoan = expense.type === "loan";
  const isPayment = expense.type === "payment";

  return (
    <article className="expense-card">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-bold">{expense.description}</h3>
          <span>{isLoan ? "Prestamo" : isPayment ? "Pago" : expense.category}</span>
          {expense.receipt || expense.receiptName ? <span>Factura</span> : null}
          {isPending ? <span>Pendiente de sincronizar</span> : null}
        </div>
        <p className="mt-1 text-sm text-[#615b52]">
          {isPayment
            ? `${formatMovementDate(expense)} - ${expense.paidBy} pago saldo a ${oppositePerson(
                expense.paidBy,
              )}`
            : isLoan
            ? `${formatMovementDate(expense)} - ${expense.paidBy} presto plata a ${oppositePerson(
                expense.paidBy,
              )}`
            : `${formatMovementDate(expense)} - Pago ${expense.paidBy} - ${splitLabel(
                expense.split,
              )}`}
        </p>
        <p className="mt-1 text-xs text-[#756f66]">
          {expense.createdBy
            ? canManage
              ? "Registrado por ti"
              : `Registrado por ${expense.createdByEmail ?? "la otra cuenta"}`
            : `Movimiento anterior asociado a ${expense.paidBy}`}
        </p>
        <p className="mt-2 text-sm font-semibold text-[#273c35]">
          {isPayment
            ? "Pago registrado para quedar a paces"
            : debt
            ? `${debt.from} debe ${currency.format(debt.amount)} a ${debt.to}`
            : "No genera deuda entre ustedes"}
        </p>
        {expense.note ? (
          <p className="mt-2 text-sm text-[#615b52]">{expense.note}</p>
        ) : null}
        {expense.receipt || expense.receiptName ? (
          <button
            className="receipt-link"
            type="button"
            onClick={() => onViewReceipt(expense)}
          >
            Ver factura
          </button>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 md:flex-col md:items-end">
        <strong className="text-lg">{currency.format(expense.amount)}</strong>
        {canManage ? (
          <div className="row-actions">
            <button type="button" onClick={() => onEdit(expense)}>
              Editar
            </button>
            <button type="button" onClick={() => onRemove(expense.id)}>
              Eliminar
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ReceiptViewer({
  receipt,
  onClose,
}: {
  receipt: Receipt;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-label="Factura adjunta"
        aria-modal="true"
        className="receipt-modal"
        role="dialog"
      >
        <div className="receipt-modal-header">
          <div>
            <h2>Factura</h2>
            <p>{receipt.name}</p>
          </div>
          <button type="button" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <img alt="Factura adjunta" src={receipt.dataUrl} />
        <a download={receipt.name || "factura.jpg"} href={receipt.dataUrl}>
          Descargar factura
        </a>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#ded6c8] bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-[#736352]">{label}</p>
      <p className="mt-2 text-xl font-bold">{value}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-[#c8bdac] bg-[#fffaf1] p-4 text-sm text-[#615b52]">
      {text}
    </div>
  );
}
