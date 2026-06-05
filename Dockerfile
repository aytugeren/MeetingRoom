FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY MeetingApp/MeetingApp.csproj MeetingApp/
RUN dotnet restore MeetingApp/MeetingApp.csproj
COPY MeetingApp/ MeetingApp/
WORKDIR /src/MeetingApp
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish .
RUN mkdir -p wwwroot/uploads
EXPOSE 5500
ENTRYPOINT ["dotnet", "MeetingApp.dll"]
