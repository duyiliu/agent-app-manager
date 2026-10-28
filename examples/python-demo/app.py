"""Project Runner 的本地 Flask 示例。"""
import logging
import os
from datetime import datetime, timezone

from flask import Flask, jsonify, request

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)


@app.get('/api/health')
def health():
    return jsonify(status='UP', application='python-demo', pid=os.getpid(), time=datetime.now(timezone.utc).isoformat())


@app.get('/api/hello')
def hello():
    return jsonify(message=f"Hello, {request.args.get('name', 'Project Runner')}!", version='v1')


@app.post('/api/logs')
def logs():
    level = request.args.get('level', 'INFO')
    levels = {'INFO': logging.INFO, 'WARN': logging.WARNING, 'ERROR': logging.ERROR}
    if level not in levels:
        return jsonify(error='level must be INFO, WARN or ERROR'), 400
    app.logger.log(levels[level], 'Demo log: %s sample', level)
    return jsonify(logged=level)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=18274, debug=False)
