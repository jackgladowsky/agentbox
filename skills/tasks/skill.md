# tasks

Manage a simple local to-do list stored in `~/.agentbox/<agent>/tasks.json`.

## CLI
- **Type:** custom script
- **Binary:** `skills/tasks/tasks.sh`
- **Install:** none — uses bash + node

## Storage
- **File:** `~/.agentbox/<agent>/tasks.json`
- **Schema:** flat JSON array of task objects
- **Task fields:** `id`, `title`, `status`, `created`, `completed`, `due`, `tags`

## Commands
```bash
# Add a task
skills/tasks/tasks.sh add --title "Buy groceries"
skills/tasks/tasks.sh add --title "Finish circuits lab" --due "2026-04-01T23:59:00-04:00" --tags "school"

# List tasks
skills/tasks/tasks.sh list
skills/tasks/tasks.sh list --status todo
skills/tasks/tasks.sh list --tag school

# Complete or remove a task
skills/tasks/tasks.sh done task_abc123
skills/tasks/tasks.sh remove task_abc123
```

## Usage Notes
- Resolve natural language into structured arguments before calling the CLI.
- Keep tags short and lowercase when possible, like `school`, `gym`, `errands`, `cooking`.
- When a task has a due date, also create a reminder for one hour before it is due.
- When the user asks what they have today, check tasks, reminders, and calendar together.
