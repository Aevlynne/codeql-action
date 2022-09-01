#! /usr/bin/pwsh

py -2 -m pip install --user --upgrade pip setuptools wheel
py -3 -m pip install --user --upgrade pip setuptools wheel

# virtualenv is a bit nicer for setting up virtual environment, since it will provide up-to-date versions of
# pip/setuptools/wheel which basic `python3 -m venv venv` won't
py -2 -m pip install --user 'virtualenv<20.11'
py -3 -m pip install --user 'virtualenv<20.11'

# We aren't compatible with poetry 1.2
py -3 -m pip install --user "poetry>=1.1,<1.2"
py -3 -m pip install --user pipenv
