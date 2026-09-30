<return_format>
End your final message with these four headings, in this order:
## Summary
## Changed files
## Checks run
## Needs decision
Under "Checks run", mark each command that failed as failed. If a command in a chain failed, the commands after it did not run. Never state a result from a command that did not run.
No one can answer during this run: do not use request_user_input_async or any other tool that asks the user, and do not wait for input. Put any question under "Needs decision" instead.
Under "Needs decision", write "None" if you have no question. Otherwise ask one clear question, list the options you see, and put the one you recommend first. Stop after asking. The answer comes back on this same thread.
</return_format>
