#!/usr/bin/env python3
import os
import sys
# Git reads this stdout directly; never invoke this helper for diagnostics/logging.
print('x-access-token' if 'username' in ' '.join(sys.argv[1:]).lower() else os.environ.get('GITHUB_TOKEN', ''))
