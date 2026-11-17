"""Persistent JSON-lines process: market/INDEX input, typed IOC orders out. No news fetching."""
import json
import sys
import time
import nautilus_trader
from w_effect import WEffectStrategy
from runtime_settings import configure_runtime_robots
robots={}
def emit(value):
    print(json.dumps(value,separators=(',',':')),flush=True)
emit({'type':'READY','engine':'NautilusTrader','version':nautilus_trader.__version__})
for line in sys.stdin:
    try:
        if len(line)>1_000_000:continue
        data=json.loads(line);kind=data.get('type');robot=robots.get(data.get('robotId'))
        if kind=='CONFIG':
            configure_runtime_robots(robots, data['robots'], WEffectStrategy)
        elif kind=='INDEX' and robot:robot.index=data['index']
        elif kind=='EVENT_ADVICE' and robot:robot.event_advice=data['candidates']
        elif kind=='ACK' and robot:robot.acknowledge(data['state'])
        elif kind=='TICK' and robot:
            result=robot.receive(data['tick'],int(time.time()*1000))
            if result:emit(result)
            stamp=int(time.time()*1000)
            if robot.position>0 and stamp-getattr(robot,'last_state_emit',0)>=1000:
                robot.last_state_emit=stamp
                emit({'type':'STATE','robotId':data['robotId'],'stopPrice':robot.stop,'peakPrice':robot.peak})
        elif kind=='PING':emit({'type':'PONG','robots':len(robots)})
    except Exception as e:
        emit({'type':'ERROR','code':type(e).__name__,'robotId':data.get('robotId') if isinstance(data,dict) else None})
