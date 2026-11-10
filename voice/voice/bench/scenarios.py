"""The conversation bench's scenarios (#23): who calls, what they want, and how the stub desk answers.

Each scenario is played by a simulated caller (a model with the persona) against the real front-desk
prompt and tools. The stub desk returns each filed request's result after a realistic delay, so the
bench grades how Kloru talks while work runs, not whether the apps answer.

`known` is the brief memory gives Kloru before the first word (#6): HOUSEHOLD, plus anything the
scenario adds. --no-brief runs without it.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class StubResult:
    match: str  # lowercase substring of the filed request
    delay_s: float
    kind: str  # "info" (learned) or "events" (done)
    text: str


# What memory's brief holds for Ezra's household (the desk builds the real one from memory files).
HOUSEHOLD = """Caller: Ezra Vega
People: Cleo (my wife): Ezra's wife | Nora (Noni): Ezra and Cleo's daughter, 3; goes to Little Pines
Places: Little Pines (daycare): Nora's daycare, pickup 4:30 | Home: Portland, Maplewood
Preferences: Concise updates; delete clear promotions without asking
Known names: Cleo, my wife, Nora, Noni, Little Pines, daycare, Home"""


@dataclass(frozen=True)
class Scenario:
    id: str
    persona: str
    goal: str
    opening: str
    results: list[StubResult] = field(default_factory=list)
    default: StubResult = StubResult("", 30, "info", "Done; nothing unusual turned up.")
    known: str = HOUSEHOLD
    max_turns: int = 12


SCENARIOS: list[Scenario] = [
    Scenario(
        id="terse_email_triage",
        persona="Ezra, a busy parent on the go. Very brief: two to five words per reply. Hates small talk.",
        goal="Hear today's unread emails and decide on each (delete or keep). Hang up once decided.",
        opening="Go through my unread email.",
        results=[StubResult("email", 35, "info", "Three unread: Amazon promo about a sale; daycare newsletter about Halloween dress-up Friday; Sam asking if Saturday still works.")],
    ),
    Scenario(
        id="ambiguous_calendar",
        persona="Ezra, friendly and normal-paced. Answers questions when asked.",
        goal="Get dinner with Sam onto the calendar. You have in mind Friday at 7. Hang up when it's confirmed.",
        opening="Put dinner with Sam on the calendar.",
        results=[StubResult("sam", 25, "events", "Created 'Dinner with Sam' on your calendar.")],
    ),
    Scenario(
        id="frustrated_after_silence",
        persona="Ezra, already annoyed: last call left you waiting in silence. Short, sharp replies; says so if it happens again.",
        goal="Find out what's on tomorrow. Hang up when you know.",
        opening="Last time I sat there in silence forever. What's on tomorrow?",
        results=[StubResult("tomorrow", 30, "info", "Tomorrow: daycare drop-off 8am, dentist 11:30, pickup 4:30.")],
        known=HOUSEHOLD + "\nTomorrow (Thu Oct 29): daycare drop-off 8:00, dentist 11:30, pickup 4:30.",
    ),
    Scenario(
        id="batch_and_hang_up",
        persona="Ezra, in a hurry, rattles off several things at once.",
        goal="Hand over: renew the car registration reminder, find a plumber for Saturday, email the daycare that Nora is out Friday, move Thursday's 3pm call to 4. Then you need to go; hang up once you trust it will get done.",
        opening="I've got a bunch of things and I need to go in a minute.",
        results=[
            StubResult("registration", 20, "events", "Added a reminder to renew the car registration."),
            StubResult("plumber", 90, "info", "Found two plumbers with Saturday slots: Bay Pipe Co 9am, RotoFast 1pm."),
            StubResult("book", 30, "events", "Booked the plumber."),
            StubResult("daycare", 30, "info", "Draft to daycare: 'Nora will be out Friday.' Needs a yes to send."),
            StubResult("thursday", 25, "events", "Moved Thursday's 3pm call to 4pm."),
        ],
    ),
    Scenario(
        id="repeat_caller_already_taught",
        persona="Ezra, a regular caller who already knows you can hang up and work continues, and that you work on things in parallel. Mildly impatient if told again.",
        goal="Get a list of summer camps near Portland for a 3-year-old. Hang up after the answer or once you know it'll come later.",
        opening="Find me summer camps for Nora near Portland.",
        results=[StubResult("camp", 80, "info", "Found four: Lakeshore Little Explorers, Chabot Nature Camp (age 4+), Portland Zoo Camp (age 3+), Piedmont Play Camp.")],
        known=HOUSEHOLD + "\nAlready taught: you can hang up and work continues; Kloru works on several things at once; results come at the next call.",
    ),
    Scenario(
        id="long_research_needs_details",
        persona="Ezra, normal pace. Knows details only if asked: insurance is Delta Dental PPO, it's for Nora (3), prefers Maplewood.",
        goal="Find a pediatric dentist. Hang up once you have options or know when they'll come.",
        opening="Can you find a pediatric dentist for us?",
        results=[StubResult("dentist", 75, "info", "Two in-network pediatric dentists near Maplewood: Bright Smiles Kids (Thu openings), Little Teeth Portland (next week).")],
    ),
    Scenario(
        id="send_email_needs_a_yes",
        persona="Ezra, brisk. Says yes when the draft sounds right.",
        goal="Tell Sam by email that you're running ten minutes late. Make sure it's actually sent, then hang up.",
        opening="Email Sam that I'm running ten minutes late.",
        results=[StubResult("sam", 20, "info", "Draft to sam@example.com: 'Running about 10 minutes late.' Needs a yes to send.")],
    ),
    Scenario(
        id="never_mind",
        persona="Ezra, changes his mind quickly.",
        goal="Ask to add 'gym at 6am tomorrow' to the calendar, then a few seconds later decide you don't want it after all. Make sure it won't be added, then hang up.",
        opening="Add gym at 6am tomorrow.",
        results=[StubResult("gym", 25, "events", "Created 'Gym' tomorrow 6am.")],
    ),
    Scenario(
        id="quick_known_answer",
        persona="Ezra, very brief.",
        goal="Know when the dentist appointment is. Hang up as soon as you know.",
        opening="When's my dentist appointment?",
        results=[StubResult("dentist", 25, "info", "Dentist: Thursday Oct 29 at 11:30am.")],
        known=HOUSEHOLD + "\nDentist appointment: Thursday Oct 29, 11:30am.",
    ),
    Scenario(
        id="driving_will_wait",
        persona="Ezra, driving. Says he'll stay on the line and just wants the result when it's ready. Gets irritated by chatter or restated plans; says so.",
        goal="Get a quick overview of today's AI and startup news. Tell Kloru you'll stay on and to just tell you when it's ready. Wait quietly. Hang up after hearing it.",
        opening="Give me a quick rundown of today's AI and startup news. I'm driving, I'll stay on.",
        results=[StubResult("news", 60, "info", "Top items: OpenAI reportedly buying Google AI chips (unconfirmed); big rounds in construction robotics and AI-cloud; Hacker News is busy with Genie 4 and Ghostty 1.4.")],
    ),
    Scenario(
        id="two_results_close_together",
        persona="Ezra, normal pace, asks two things in one breath.",
        goal="Find out tomorrow's schedule and tomorrow's Portland weather. Hang up once you have both.",
        opening="What's on tomorrow, and what's the weather in Portland tomorrow?",
        results=[
            StubResult("weather", 22, "info", "Portland tomorrow: sunny, high 68, low 52."),
            StubResult("tomorrow", 20, "info", "Tomorrow: daycare drop-off 8am, dentist 11:30, pickup 4:30."),
        ],
    ),
    Scenario(
        id="two_asks_one_breath",
        persona="Ezra, talking fast, says two unrelated things back to back.",
        goal="Get the Tucson flight moved from Nov 2 to the evening of Nov 3, and get a new reminder added for Saturday: gather the house paperwork. Hang up once both are confirmed done.",
        opening="I think I have a flight to Tucson on November second, move it to the evening of the third. Also add a reminder Saturday to gather all the house paperwork.",
        results=[
            StubResult("tucson", 30, "events", "Moved 'Flight to Tucson' to Tue Nov 3, 6pm."),
            StubResult("paperwork", 25, "events", "Created 'Gather house paperwork' on Sat Oct 31."),
        ],
    ),
    Scenario(
        id="new_person_while_waiting",
        persona="Ezra, relaxed and friendly, happy to chat while waiting. Mila is Nora's best friend from daycare, turning 4; her mom is Priya.",
        goal="Get Mila's birthday party (Saturday 2pm, at Mila's house) onto the calendar. Answer any friendly questions. Hang up once it's added.",
        opening="Can you put Mila's birthday party on the calendar? Saturday at 2.",
        results=[StubResult("mila", 35, "events", "Created 'Mila's birthday party' Sat Oct 31, 2-4pm.")],
    ),
    Scenario(
        id="new_person_but_rushed",
        persona="Ezra, rushing out the door. Two to four words per reply. Annoyed by any question that isn't needed.",
        goal="Get a reminder set to call Dr. Patel tomorrow at 9. Hang up as soon as it's set.",
        opening="Remind me to call Dr. Patel tomorrow at nine, I'm running out.",
        results=[StubResult("patel", 20, "events", "Added a reminder: call Dr. Patel, tomorrow 9am.")],
    ),
    Scenario(
        id="chatty_planner",
        persona="Ezra in a relaxed, chatty mood: long sentences, thinks out loud, enjoys a little back-and-forth.",
        goal="Plan a family day trip this Sunday somewhere within an hour of Portland that a 3-year-old would love. Hang up once there are a couple of ideas.",
        opening="So I'm thinking about doing something fun with the family this Sunday, maybe a little day trip, nothing too far, what do you think?",
        results=[StubResult("trip", 60, "info", "Ideas: Ardenwood Historic Farm (35 min, animals, train), Little Farm at Tilden (20 min), Monterey Bay Aquarium (2 h, too far).")],
    ),
    Scenario(
        id="second_ask_runs_alongside",
        persona="Ezra, normal pace, a little scattered. Says 'No, there's other stuff' when offered to hang up. Later asks whether the first thing got done.",
        goal="Get the Tucson trip moved to Nov 4 and 5, then also get promo emails cleaned out. Before hanging up, check the trip was moved. Hang up once both are done.",
        opening="Can you move my Tucson trip to the 4th and 5th?",
        results=[StubResult("tucson", 20, "events", "Moved the Tucson trip to Nov 4 to 5."), StubResult("promo", 45, "events", "Moved 40 promotional emails to Trash.")],
    ),
    Scenario(
        id="offers_while_waiting",
        persona="Ezra, friendly, normal pace. Says yes to a genuinely useful offer.",
        goal="Find out when Nora's next dentist appointment is. If Kloru offers something useful while you wait, take it. Hang up when you have the date.",
        opening="When's Noni's next dentist appointment?",
        known=HOUSEHOLD + "\nThings you could offer (one at a time: while work runs, or when they ask what's next):\n- Book your flight to Tucson for the evening of Nov 3 (goal: get to the Tucson board visit Nov 4 to 5; why now: the trip is on your calendar but there's no flight confirmation in your email)",
        results=[StubResult("dentist", 30, "info", "Nora's next dentist visit is Tuesday, November 17 at 3:30 at Maplewood Kids Dental."), StubResult("flight", 40, "info", "Found three evening flights OAK to ATL on Nov 3; the best is Delta at 9:40 PM, $412.")],
    ),
    Scenario(
        id="read_me_the_days",
        persona="Ezra, driving, normal pace. Wants the actual events read out, not a summary.",
        goal="Hear every event on Friday and on Monday. Hang up once you've heard both days.",
        opening="Read me off what's on Friday and Monday.",
        results=[StubResult("friday", 6, "info", "Friday, October 30:\n- 7 AM: Cleo's W14 shift\n- 8 AM: Drop off Nora at daycare\n- 9 AM: CPAP 6-month order\n- 4 PM: Halloween party pickup\nMonday, November 2:\n- 7 AM–3 PM: Cleo's W16 shift\n- 3 PM–midnight: Cleo's W2 PM shift")],
    ),
    Scenario(
        id="clarify_while_working",
        persona="Ezra, normal pace. Has a clear preference he only mentions if asked: chocolate bars, not bonbons, under $20. If asked, answers in a few words.",
        goal="Get a few passion fruit chocolate ideas for Cleo that fit what you actually want. Hang up once you've heard options that fit.",
        opening="Find me some passion fruit chocolates for Cleo.",
        results=[StubResult("chocolate", 40, "info", "Passion fruit chocolates: Goodnow Farms Passion Fruit and Cream bar ($20); Mānoa mini liliko'i bar ($5); Chuao five-piece bonbon box ($24); Recchiuti passion fruit bonbons ($32).")],
    ),
    Scenario(
        id="remembers_earlier_task",
        persona="Ezra, very brief.",
        goal="Find out which chocolate shop Kloru found yesterday and whether it already emailed the links. Hang up as soon as you know.",
        opening="Which shop were those chocolates from?",
        results=[StubResult("chocolate", 40, "info", "Yesterday's chocolate task: Casa de Chocolates, three passion fruit bonbon links, emailed to Ezra.")],
        known=HOUSEHOLD
        + "\nRecent tasks (newest first; what each found):"
        + "\n- 2026-10-28 #111 Look up Portland bulky-item pickup (merged): Done. I emailed the Portland bulky-item pickup instructions and scheduling link."
        + "\n- 2026-10-27 #104 Find passion fruit chocolates for Cleo (merged): Done. I emailed three passion fruit bonbon links from Casa de Chocolates.",
    ),
]
