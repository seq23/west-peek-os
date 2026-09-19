import type { PageGuide } from "./types";

/** Employees, as deployed on 287ee44 — who is on duty, every employee's card and switch, the detail panel, handoffs, department rooms. */
export const employeesGuide: PageGuide = {
  navKey: "employees",
  title: "Employees",
  purpose:
    "Your AI employees — who is on duty this hour, who is employed and who is switched off, what each is doing and costing, and the controls over them: employ, pause, review, retire.",
  youCan: ["See who is on duty right now", "Employ or switch off an employee, one press", "Open someone's card — their work, runs and scorecard", "Accept or reject a handoff between employees"],
  sources: ["src/client/pages/EmployeesPage.tsx"],
  bands: [
    { name: "On duty now", testid: "on-duty", shows: "who is on point this hour and who is rostered but benched — click a benched name to put them on point." },
    { name: "Find someone", testid: "lounge-search", shows: "filters by department, working or not, and a search by name, role or what you need doing." },
    { name: "The teams", testid: "lounge-grid", shows: "one card per employee per team — status, the switch, role, voice, cost and tools." },
    { name: "Former employees", testid: "lounge-retired", shows: "who was retired, with advice on whether to bring them back." },
    { name: "Editing", testid: "employee-detail-anchor", shows: "the open employee — current work, recent runs, scorecard, lifecycle, manager review, history." },
    { name: "Handoffs", testid: "handoffs-panel", shows: "cards one employee wants to pass to another, waiting on you." },
    { name: "Department rooms", testid: "rooms-panel", shows: "each department's room and its announcements." },
  ],
  acts: [
    {
      label: "Employ",
      testid: "employee-toggle-",
      primary: true,
      does: "employs a switched-off employee in one press; Working — turn off pauses a working one.",
      then: "First employment raises an approval card; if you hold the role it is approved as you press.",
      who: "a person",
    },
    { label: "Open", testid: "employee-open-", does: "opens the employee's card below." },
    { label: "Record review", testid: "employee-review-submit-", primary: true, does: "records a manager review with a finding and a disposition.", who: "Managing Partner" },
    { label: "Compute scorecard (last 30 days)", testid: "employee-compute-", does: "works out the employee's scorecard from the last thirty days." },
    { label: "Request activation", testid: "employee-request-activation-", does: "the long way round — raises the approval card without employing; Activate (approved) finishes it once the card is signed." },
    { label: "Accept", testid: "handoff-accept-", does: "moves the card to the employee who asked for it; Reject leaves it where it is." },
    { label: "Post announcement", testid: "room-announce-submit", primary: true, does: "posts to the open department room." },
    { label: "Bring back", testid: "retired-unretire-", does: "brings a retired employee back; Should we? asks first.", who: "Managing Partner" },
  ],
  auto: [
    { what: "The on-duty panel reads the hour from your clock and shows who is on point for it", when: "on every visit" },
    { what: "The sweep works the cards employees own — what shows under Current work", when: "every few minutes", job: "employee_work_sweep" },
  ],
  elsewhere: [
    { page: "approvals", why: "where a first employment is signed for." },
    { page: "ai-controls", why: "the duty roster itself, and the providers." },
    { page: "work", why: "every card an employee is carrying." },
  ],
};
