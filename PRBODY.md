## Summary

Do not auto-run plugin panel command-output on open

## Changes

- Opening a panel no longer executes command-output widgets
- Seed idle output slots; user must click re-run to execute (avoids silent repo mutation)

Fixes #61
