"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./supabaseClient";

type Person = "Alejo" | "Aleja";
type MovementType = "expense" | "loan" | "payment";
type ActiveTab = "home" | "accounts" | "analysis" | "movements";
type SplitMode = "shared" | "alejo" | "aleja";
type Receipt = { name: string; dataUrl: string };
type Expense = {
  id: string;
  type?: MovementType;
  description: string;
  amount: number;
  category: string;
  paidBy: Person;
  split: SplitMode;
  date: string;
  note: string;
  receipt?: Receipt;
};
type ExpenseDraft = Omit<Expense, "id" | "amount" | "receipt"> & {
  amount: string;
  receipt?: Receipt;
};

const STORAGE_KEY = "casa-aleja-alejo-expenses";
const HOUSEHOLD_ID = "aleja-alejo";
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

function getStoredExpenses() {
  if (typeof window === "undefined") return [];

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as Expense[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalExpenses(expenses: Expense[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(expenses));
}

async function loadRemoteExpenses() {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("house_movements")
    .select("data")
    .eq("household_id", HOUSEHOLD_ID)
    .order("movement_date", { ascending: false });

  if (error) {
    console.warn("No se pudieron cargar movimientos de Supabase", error);
    return null;
  }

  return (data ?? []).map((row) => row.data as Expense);
}

async function upsertRemoteExpense(expense: Expense) {
  if (!supabase) return;

  const { error } = await supabase.from("house_movements").upsert({
    id: expense.id,
    household_id: HOUSEHOLD_ID,
    movement_date: expense.date,
    data: expense,
  });

  if (error) {
    console.warn("No se pudo guardar en Supabase", error);
  }
}

async function deleteRemoteExpense(id: string) {
  if (!supabase) return;

  const { error } = await supabase
    .from("house_movements")
    .delete()
    .eq("id", id)
    .eq("household_id", HOUSEHOLD_ID);

  if (error) {
    console.warn("No se pudo eliminar en Supabase", error);
  }
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

function csvCell(value: string | number) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function movementTypeLabel(expense: Expense) {
  if (expense.type === "loan") return "Prestamo";
  if (expense.type === "payment") return "Pago";
  return "Compra o gasto";
}

export default function Home() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [draft, setDraft] = useState<ExpenseDraft>(initialDraft);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("Todas");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
      if (isSupabaseConfigured && !user) {
        setExpenses([]);
        setHasLoaded(true);
        return;
      }

      const remoteExpenses = isSupabaseConfigured
        ? await loadRemoteExpenses()
        : null;
      const localExpenses = getStoredExpenses();
      const nextExpenses =
        remoteExpenses && remoteExpenses.length > 0
          ? remoteExpenses
          : localExpenses;

      if (
        isSupabaseConfigured &&
        remoteExpenses &&
        remoteExpenses.length === 0 &&
        localExpenses.length > 0
      ) {
        await Promise.all(localExpenses.map((expense) => upsertRemoteExpense(expense)));
      }

      setExpenses(nextExpenses);
      saveLocalExpenses(nextExpenses);
      setHasLoaded(true);
    }

    void loadExpenses();
  }, [authReady, user]);

  useEffect(() => {
    if (hasLoaded) saveLocalExpenses(expenses);
  }, [expenses, hasLoaded]);

  const totals = useMemo(() => {
    const paid = { Alejo: 0, Aleja: 0 };
    const owed = { Alejo: 0, Aleja: 0 };
    const directDebts = { Alejo: 0, Aleja: 0 };
    const byCategory = new Map<string, number>();
    let sharedTotal = 0;
    let loanTotal = 0;

    for (const expense of expenses) {
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
      total: expenses.reduce((sum, expense) => sum + expense.amount, 0),
      paid,
      owed,
      directDebts,
      sharedTotal,
      loanTotal,
      categoryRows,
      topCategory: categoryRows[0],
      settle,
    };
  }, [expenses]);

  const filteredExpenses = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    return expenses
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
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [categoryFilter, dateFrom, dateTo, expenses, query]);

  function updateDraft<K extends keyof ExpenseDraft>(
    key: K,
    value: ExpenseDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function attachReceipt(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    updateDraft("receipt", await readReceipt(file));
  }

  function addExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(draft.amount);
    if (!draft.description.trim() || !Number.isFinite(amount) || amount <= 0) {
      return;
    }

    const savedExpense: Expense = {
      ...draft,
      id: editingId ?? crypto.randomUUID(),
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

    setExpenses((current) =>
      editingId
        ? current.map((expense) =>
            expense.id === editingId ? savedExpense : expense,
          )
        : [savedExpense, ...current],
    );
    void upsertRemoteExpense(savedExpense);
    setDraft({ ...initialDraft, paidBy: draft.paidBy, date: today });
    setEditingId(null);
    setIsModalOpen(false);
  }

  function removeExpense(id: string) {
    setExpenses((current) => current.filter((expense) => expense.id !== id));
    void deleteRemoteExpense(id);
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

  function editExpense(expense: Expense) {
    setDraft({
      type: expense.type ?? "expense",
      description: expense.description,
      amount: String(expense.amount),
      category: expense.category,
      paidBy: expense.paidBy,
      split: expense.split,
      date: expense.date,
      note: expense.note,
      receipt: expense.receipt,
    });
    setEditingId(expense.id);
    setIsModalOpen(true);
  }

  function registerSettlementPayment() {
    if (!hasBalance) return;
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
      note: `Pago para quedar a paces con ${to}.`,
    };

    setExpenses((current) => [payment, ...current]);
    void upsertRemoteExpense(payment);
  }

  function exportToExcel() {
    const headers = [
      "Fecha",
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
    setExpenses([]);
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
    if (expenses.length === 0) return;
    if (window.confirm("Borrar todos los gastos registrados?")) {
      if (supabase) {
        await Promise.all(expenses.map((expense) => deleteRemoteExpense(expense.id)));
      }
      setExpenses([]);
    }
  }

  const maxCategoryAmount = totals.categoryRows[0]?.amount ?? 0;
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
              <Metric label="Total" value={currency.format(totals.total)} />
              <Metric label="Compartidos" value={currency.format(totals.sharedTotal)} />
              <Metric label="Prestamos" value={currency.format(totals.loanTotal)} />
              <Metric
                label="Top categoria"
                value={totals.topCategory?.category ?? "Sin datos"}
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
                {expenses.length === 0 ? (
                  <EmptyState text="Registra el primer movimiento para empezar." />
                ) : (
                  expenses.slice(0, 3).map((expense) => (
                    <ExpenseRow
                      expense={expense}
                      key={expense.id}
                      onEdit={editExpense}
                      onRemove={removeExpense}
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
              <h2 className="text-xl font-bold">En que gastamos mas</h2>
              <p className="text-sm text-[#615b52]">
                Comparacion por categoria con los gastos registrados.
              </p>
              <div className="mt-4 grid gap-3">
                {totals.categoryRows.length === 0 ? (
                  <EmptyState text="Cuando registren gastos, aqui apareceran los indicadores." />
                ) : (
                  totals.categoryRows.map((row) => (
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
                  Limpiar datos
                </button>
              </div>
            </section>
            <div className="grid gap-3">
              {filteredExpenses.length === 0 ? (
                <EmptyState text="No hay gastos para mostrar con este filtro." />
              ) : (
                filteredExpenses.map((expense) => (
                  <ExpenseRow
                    expense={expense}
                    key={expense.id}
                    onEdit={editExpense}
                    onRemove={removeExpense}
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
    </main>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setIsSubmitting(true);

    if (!supabase) {
      setMessage("Supabase no esta configurado.");
      setIsSubmitting(false);
      return;
    }

    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setIsSubmitting(false);

    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage("Usuario creado. Revisa tu correo si Supabase pide confirmar.");
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
          <span>Ingresa con correo y clave para ver los gastos.</span>

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
              {isSubmitting
                ? "Un momento..."
                : mode === "signin"
                  ? "Entrar"
                  : "Crear cuenta"}
            </button>
          </form>

          {message ? <div className="auth-message">{message}</div> : null}

          <button
            className="auth-switch"
            type="button"
            onClick={() => {
              setMode((current) => (current === "signin" ? "signup" : "signin"));
              setMessage("");
            }}
          >
            {mode === "signin"
              ? "Crear cuenta nueva"
              : "Ya tengo cuenta, entrar"}
          </button>
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
              <label className="receipt-button">
                Adjuntar factura
                <input
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  type="file"
                  onChange={onAttachReceipt}
                />
              </label>
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
                  En celular puede abrir la camara para tomar la foto.
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
  expense,
  onEdit,
  onRemove,
}: {
  expense: Expense;
  onEdit: (expense: Expense) => void;
  onRemove: (id: string) => void;
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
          {expense.receipt ? <span>Factura</span> : null}
        </div>
        <p className="mt-1 text-sm text-[#615b52]">
          {isPayment
            ? `${expense.date} - ${expense.paidBy} pago saldo a ${oppositePerson(
                expense.paidBy,
              )}`
            : isLoan
            ? `${expense.date} - ${expense.paidBy} presto plata a ${oppositePerson(
                expense.paidBy,
              )}`
            : `${expense.date} - Pago ${expense.paidBy} - ${splitLabel(
                expense.split,
              )}`}
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
        {expense.receipt ? (
          <a
            className="receipt-link"
            href={expense.receipt.dataUrl}
            target="_blank"
          >
            Ver factura
          </a>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 md:flex-col md:items-end">
        <strong className="text-lg">{currency.format(expense.amount)}</strong>
        <div className="row-actions">
          <button type="button" onClick={() => onEdit(expense)}>
            Editar
          </button>
          <button type="button" onClick={() => onRemove(expense.id)}>
            Eliminar
          </button>
        </div>
      </div>
    </article>
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
