# Mission control

A Claude mod that adds a threads panel and a usage band. The panel lists every thread in the current project, colour-coded by state (amber needs you, green working, grey idle, blue done, red failed), with the current checklist step, a progress bar, time since last activity and what each thread has made. A Map view draws how threads hang off the project chat. The band above the chat box shows the 5-hour and weekly limits, reset countdowns, an estimated pace forecast, and tips for saving usage when it runs high. Type /mission-control to reopen the panel.

## What it shows

- **Mission control panel**: every thread in your project, colour-coded. Amber = needs your answer (pinned to the top, pulsing), green = working, grey = idle, blue = done, red = failed. Each card shows the current step with a progress bar, time since last activity, and what the thread has made. Use **List** / **Map** at the top to switch views.
- **Usage strip above the chat box**: your 5-hour and weekly usage, reset countdowns, and an estimated forecast based on the last hour's pace. A **Help me save usage** button appears past 60%.

Thread tracking works inside Claude project threads; the usage strip works everywhere.

## Install

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `warth0gGit/MissionControl`, then **Add plugin** and pick **mission-control**.

At the prompt of a Claude Code terminal session:

`/plugin install mission-control --marketplace warth0gGit/MissionControl`

From a shell:

`claude plugin install mission-control --marketplace warth0gGit/MissionControl`
