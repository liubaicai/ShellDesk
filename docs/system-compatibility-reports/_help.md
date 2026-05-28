# help & tools

## 部分组件安装方案

``` shell
# elasticsearch
podman run -d \ 
   --name elasticsearch \ 
   -p 9200:9200 -p 9300:9300 \ 
   -e "discovery.type=single-node"  \ 
   -e "ES_JAVA_OPTS=-Xms1g -Xmx1g" \ 
   -v es_data:/usr/share/elasticsearch/data \ 
   docker.elastic.co/elasticsearch/elasticsearch:8.17.4
podman exec -it elasticsearch /usr/share/elasticsearch/bin/elasticsearch-reset-password -u elastic
```

``` shell
# rabbitmq
podman run -d \ 
  --name my-rabbitmq \ 
  -p 5672:5672 \ 
  -p 15672:15672 \ 
  -e RABBITMQ_DEFAULT_USER=admin \ 
  -e RABBITMQ_DEFAULT_PASS=admin \ 
  rabbitmq:management
```

``` shell
# vnc-server
podman run -d \ 
  --name my-vnc-container \ 
  -p 5900:5901 \ 
  -p 6900:6901 \ 
  -e VNC_PW=password \ 
  docker.io/accetto/ubuntu-vnc-xfce-g3
```
